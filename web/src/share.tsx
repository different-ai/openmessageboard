import type { Board, Invite, InviteAudience } from "@openmessageboard/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./api";
import { addDays, endOfDay, endOfFriday, formatDateTime, formatZoned, fromLocalInput, localTimeZone, toLocalInput } from "./format";
import { CopyField, Dialog, ErrorNote, Field, Loading, useToast } from "./ui";

type InviteStatus = "active" | "expired" | "disabled" | "used_up";

export function inviteStatus(inv: Invite, now = Date.now()): InviteStatus {
  if (inv.disabled_at) return "disabled";
  if (inv.join_by && Date.parse(inv.join_by) <= now) return "expired";
  if (inv.max_uses !== null && inv.uses >= inv.max_uses) return "used_up";
  return "active";
}

const STATUS_LABEL: Record<InviteStatus, string> = {
  active: "Active",
  expired: "Expired",
  disabled: "Disabled",
  used_up: "Used up",
};

const AUDIENCE_LABEL: Record<InviteAudience, string> = {
  link: "Anyone with the link",
  email: "One email address",
  domain: "Company domain",
};

function defaultJoinBy(audience: InviteAudience) {
  return audience === "email" ? "" : toLocalInput(addDays(new Date(), 7));
}

export function ShareDialog({ board, open, onClose }: { board: Board; open: boolean; onClose: () => void }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [created, setCreated] = useState<Invite | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setListError(null);
    api
      .invites(board.id)
      .then((r) => setInvites(r.invites))
      .catch(setListError);
  }, [open, board.id]);

  return (
    <Dialog open={open} onClose={onClose} title={`Share ${board.name}`} wide>
      {created?.url ? (
        <div className="stack">
          <p className="note note-success">
            Invite created. <strong>Copy the link now:</strong> it's shown only once. To share again later, create another link.
          </p>
          <CopyField label="Invite link" value={created.url} />
          <InviteSummary inv={created} />
          <div className="actions">
            <button type="button" className="button" onClick={() => setCreated(null)}>
              Create another
            </button>
            <button type="button" className="button button-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <InviteForm
          boardId={board.id}
          onCreated={(inv) => {
            setCreated(inv);
            setInvites((all) => [inv, ...(all ?? [])]);
          }}
        />
      )}
      <section className="invite-list" aria-labelledby="invite-list-title">
        <h3 id="invite-list-title">Invites</h3>
        <ErrorNote error={listError} />
        {invites === null && !listError ? (
          <Loading />
        ) : invites && invites.length === 0 ? (
          <p className="muted">No invites yet.</p>
        ) : (
          <ul className="rows">
            {invites?.map((inv) => (
              <InviteRow key={inv.id} inv={inv} onDisabled={(d) => setInvites((all) => all?.map((x) => (x.id === d.id ? d : x)) ?? null)} />
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}

function InviteSummary({ inv }: { inv: Invite }) {
  return (
    <dl className="facts">
      <div>
        <dt>Who can join</dt>
        <dd>
          {AUDIENCE_LABEL[inv.audience]}
          {inv.audience_value ? `: ${inv.audience_value}` : ""}
        </dd>
      </div>
      <div>
        <dt>Role</dt>
        <dd className="cap">{inv.role}</dd>
      </div>
      <div>
        <dt>Join by</dt>
        <dd>{inv.join_by ? formatZoned(inv.join_by) : "No deadline"}</dd>
      </div>
      <div>
        <dt>Access ends</dt>
        <dd>{inv.access_ends_at ? formatZoned(inv.access_ends_at) : "Never"}</dd>
      </div>
      <div>
        <dt>Uses</dt>
        <dd>
          {inv.uses}
          {inv.max_uses !== null ? ` of ${inv.max_uses}` : ""}
        </dd>
      </div>
    </dl>
  );
}

function InviteRow({ inv, onDisabled }: { inv: Invite; onDisabled: (inv: Invite) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const status = inviteStatus(inv);
  return (
    <li className="row">
      <div className="row-main">
        <div className="row-title">
          {AUDIENCE_LABEL[inv.audience]}
          {inv.audience_value && <span className="mono"> {inv.audience_value}</span>}
          <span className={`badge invite-${status}`}>{STATUS_LABEL[status]}</span>
        </div>
        <div className="row-meta">
          <span className="cap">{inv.role}</span>
          <span>
            {inv.uses}
            {inv.max_uses !== null ? `/${inv.max_uses}` : ""} used
          </span>
          {inv.join_by && <span>Join by {formatDateTime(inv.join_by)}</span>}
          {inv.access_ends_at && <span>Access ends {formatDateTime(inv.access_ends_at)}</span>}
          <span>Created {formatDateTime(inv.created_at)}</span>
        </div>
        <ErrorNote error={error} />
      </div>
      {status !== "disabled" && (
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.disableInvite(inv.id);
              onDisabled({ ...inv, disabled_at: new Date().toISOString() });
              toast("Invite disabled. Nobody new can join with it.", "success");
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Disable
        </button>
      )}
    </li>
  );
}

function InviteForm({ boardId, onCreated }: { boardId: string; onCreated: (inv: Invite) => void }) {
  const ids = { value: useId(), role: useId(), joinBy: useId(), ends: useId(), uses: useId() };
  const [audience, setAudience] = useState<InviteAudience>("link");
  const [value, setValue] = useState("");
  const [role, setRole] = useState<"reader" | "contributor">("contributor");
  const [joinBy, setJoinBy] = useState(defaultJoinBy("link"));
  const [accessEnds, setAccessEnds] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tz = localTimeZone();
  const joinByIso = fromLocalInput(joinBy);
  const endsIso = fromLocalInput(accessEnds);
  const minNow = toLocalInput(new Date());

  function chooseAudience(a: InviteAudience) {
    setAudience(a);
    setValue("");
    setJoinBy(defaultJoinBy(a));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (joinByIso && Date.parse(joinByIso) <= Date.now()) return setError(new Error("Join by must be in the future."));
    if (endsIso && Date.parse(endsIso) <= Date.now()) return setError(new Error("Access ends must be in the future."));
    setBusy(true);
    try {
      const { invite } = await api.createInvite(boardId, {
        audience,
        value: audience === "link" ? undefined : value.trim(),
        role,
        join_by: joinByIso,
        access_ends_at: endsIso,
        max_uses: audience === "email" || !maxUses ? null : Number(maxUses),
      });
      onCreated(invite);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <fieldset className="radio-cards">
        <legend>Who can join</legend>
        {(["link", "email", "domain"] as const).map((a) => (
          <label key={a} className={`radio-card ${audience === a ? "selected" : ""}`}>
            <input type="radio" name="audience" value={a} checked={audience === a} onChange={() => chooseAudience(a)} />
            <span className="radio-card-title">{AUDIENCE_LABEL[a]}</span>
            <span className="radio-card-hint">
              {a === "link"
                ? "Any signed-in person who has the link."
                : a === "email"
                  ? "One verified address. Single use."
                  : "Verified addresses at one domain, no subdomains."}
            </span>
          </label>
        ))}
      </fieldset>

      {audience !== "link" && (
        <Field label={audience === "email" ? "Email address" : "Domain"} htmlFor={ids.value}>
          <input
            id={ids.value}
            type={audience === "email" ? "email" : "text"}
            value={value}
            required
            autoComplete="off"
            placeholder={audience === "email" ? "maya@example.com" : "example.com"}
            pattern={audience === "domain" ? "[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}" : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      )}

      <div className="grid-2">
        <Field label="Role" htmlFor={ids.role} hint={role === "reader" ? "Can read and follow threads." : "Can post, reply and claim tasks."}>
          <select id={ids.role} value={role} onChange={(e) => setRole(e.target.value as "reader" | "contributor")}>
            <option value="contributor">Contributor</option>
            <option value="reader">Reader</option>
          </select>
        </Field>
        {audience !== "email" && (
          <Field label="Max uses" htmlFor={ids.uses} hint="Leave empty for no limit.">
            <input
              id={ids.uses}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </Field>
        )}
      </div>

      <div className="grid-2">
        <Field
          label="Join by"
          htmlFor={ids.joinBy}
          hint={joinByIso ? `The link stops working ${formatZoned(joinByIso)}.` : "No deadline to join."}
        >
          <div className="input-with-action">
            <input id={ids.joinBy} type="datetime-local" min={minNow} value={joinBy} onChange={(e) => setJoinBy(e.target.value)} />
            {joinBy && (
              <button type="button" className="button button-small" onClick={() => setJoinBy("")}>
                Clear
              </button>
            )}
          </div>
        </Field>
        <Field
          label="Access ends"
          htmlFor={ids.ends}
          hint={endsIso ? `Members who join end at ${formatZoned(endsIso)}.` : "Optional. Access doesn't end on its own."}
        >
          <div className="input-with-action">
            <input id={ids.ends} type="datetime-local" min={minNow} value={accessEnds} onChange={(e) => setAccessEnds(e.target.value)} />
            {accessEnds && (
              <button type="button" className="button button-small" onClick={() => setAccessEnds("")}>
                Clear
              </button>
            )}
          </div>
          <div className="presets" role="group" aria-label="Access ends presets">
            <button type="button" className="link-button" onClick={() => setAccessEnds(toLocalInput(endOfDay(new Date())))}>
              End of today
            </button>
            <button type="button" className="link-button" onClick={() => setAccessEnds(toLocalInput(endOfFriday()))}>
              Through Friday
            </button>
            <button type="button" className="link-button" onClick={() => setAccessEnds(toLocalInput(endOfDay(addDays(new Date(), 30))))}>
              30 days
            </button>
          </div>
        </Field>
      </div>
      {joinByIso && endsIso && Date.parse(endsIso) < Date.parse(joinByIso) && (
        <p className="hint warn-text">Access ends before Join by, so anyone who joins after {formatZoned(endsIso)} gets no access.</p>
      )}
      <p className="hint">Times are in your time zone ({tz}).</p>

      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Creating…" : "Create invite link"}
        </button>
      </div>
    </form>
  );
}

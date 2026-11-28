import type { AccessExplanation, Channel, Grant, GrantPrincipal, Member, Permission } from "@openmessageboard/protocol";
import { useId, useState, type FormEvent } from "react";
import { api, type CreateGrantInput } from "../api";
import { useBoard, useBoardChanges } from "../board";
import { DEFAULT_CHANNEL, channelError } from "../channels";
import { covers, isPublicGrant, publicCanRead, type GrantLike } from "../publicAccess";
import { useTitle } from "../router";
import { ConfirmDialog, Dialog, Empty, ErrorNote, Loading, useLoad, useToast } from "../ui";

const PERMS: Permission[] = ["read", "post", "react", "label", "manage"];
const GROUPS = [
  { kind: "everyone", label: "Everyone", hint: "every member, the owner included" },
  { kind: "contributors", label: "Contributors", hint: "members whose role is contributor" },
  { kind: "readers", label: "Readers", hint: "members whose role is reader" },
] as const;

const PATTERN_RE = /^(\*|[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,40}){0,5}\/?)$/;

function principalLabel(p: GrantPrincipal, members: Member[]): string {
  if (p.kind === "public") return "The public";
  if (p.kind !== "member") return GROUPS.find((g) => g.kind === p.kind)!.label;
  const m = members.find((x) => x.principal.id === p.principal_id);
  return m ? `@${m.handle}` : "Former member";
}

function permsText(perms: Permission[]): string {
  return perms.length === 0 ? "nothing" : perms.length === PERMS.length ? "everything" : perms.join(", ");
}

export function Access() {
  const { board, members, isOwner } = useBoard();
  useTitle(`Access · ${board.name}`);
  const grants = useLoad((signal) => api.grants(board.id, signal), [board.id]);
  // Each channel's `public` flag is the server's answer to "can people who are not members read it".
  const channels = useLoad((signal) => api.channels(board.id, signal), [board.id]);
  const reload = () => {
    grants.reload();
    channels.reload();
  };
  useBoardChanges((c) => {
    if (c.type === "board.updated") reload();
  }, reload);
  const [editing, setEditing] = useState<Grant | null>(null);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const toast = useToast();
  const all = grants.data?.grants ?? null;
  // Public grants have their own section: they name people who are not members, and only the owner changes them.
  const list = all?.filter((g) => !isPublicGrant(g)) ?? null;

  return (
    <div className="page-section">
      <h1 className="page-title">Access</h1>
      <p className="muted">
        Board roles cap what each member can do. Grants open or narrow that per channel: the most specific pattern decides (an exact channel, then
        the longest subtree such as <code>security/</code>, then <code>*</code>), then the closest principal (a member, then a role group, then
        everyone). Grants tied there add up. With no grants, roles decide everything.
      </p>

      <ExplainCard />

      <PublicAccess grants={all ?? []} channels={channels.data?.channels ?? null} onRevoke={setRevoking} onChanged={reload} />

      <section aria-labelledby="grants-title">
        <div className="section-head">
          <h2 id="grants-title" className="section-title">
            Grants {list && <span className="count">{list.length}</span>}
          </h2>
        </div>
        <ErrorNote error={grants.error} />
        {list === null && !grants.error ? (
          <Loading label="Loading grants…" />
        ) : list && list.length === 0 ? (
          <Empty title={isOwner ? "No grants yet" : "No grants you can manage"}>
            <p>{isOwner ? "Every member can use every channel within their role. Add a grant to open or close channels." : "The owner, or a member with manage, changes grants."}</p>
          </Empty>
        ) : (
          <ul className="rows grant-rows" aria-label="Grants">
            {list?.map((g) => (
              <li key={g.id} className="row grant-row">
                <div className="row-main">
                  <div className="grant-who">{g.principals.map((p) => principalLabel(p, members)).join(", ")}</div>
                  <ul className="grant-can">
                    {Object.entries(g.can).map(([pattern, perms]) => (
                      <li key={pattern}>
                        <code>{pattern}</code> <span className={perms.length ? "" : "warn-text"}>{permsText(perms)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="muted small mono">{g.id}</div>
                </div>
                <div className="row-actions">
                  <button type="button" className="button button-small" onClick={() => setEditing(g)}>
                    Edit
                  </button>
                  <button type="button" className="button button-small button-danger" onClick={() => setRevoking(g)}>
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner && <GrantForm onSaved={reload} />}

      <Dialog open={!!editing} onClose={() => setEditing(null)} title="Edit grant" wide>
        {editing && (
          <GrantForm
            grant={editing}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoking}
        title={revoking && isPublicGrant(revoking) ? "Close this to the public?" : "Revoke grant?"}
        confirmLabel={revoking && isPublicGrant(revoking) ? "Revoke public grant" : "Revoke"}
        body={
          revoking && isPublicGrant(revoking) ? (
            <p>
              People who are not members can no longer read what this grant opened, from their next request, and their agents lose it with them.
              Members keep their access. What was already read or copied can't be taken back.
            </p>
          ) : (
            <p>What it gives stops from the next request. If it kept someone in a closed channel, they lose access.</p>
          )
        }
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeGrant(revoking.id);
          toast(isPublicGrant(revoking) ? "Public grant revoked" : "Grant revoked", "success");
          reload();
        }}
      />
    </div>
  );
}

const channelNames = (list: Channel[]) => list.map((c) => `#${c.path}`).join(", ");

/**
 * Public access (spec 11 §Public access): which channels people who are not members can read. Everyone with the
 * Access page sees what is public; only the owner, in person, opens or closes it, and the server refuses anyone else.
 */
function PublicAccess({ grants, channels, onRevoke, onChanged }: { grants: Grant[]; channels: Channel[] | null; onRevoke: (g: Grant) => void; onChanged: () => void }) {
  const { board, isOwner } = useBoard();
  // Servers may switch public access off (the `public` profile in discovery).
  const offered = useLoad(() => api.serverInfo().then((s) => s.profiles.includes("public")), []).data;
  const publicGrants = grants.filter(isPublicGrant);
  const open = channels?.filter((c) => c.public) ?? [];
  const isPublic = board.visibility === "public";
  return (
    <section className="card public-access" aria-labelledby="public-title">
      <h2 id="public-title" className="card-title">
        Public access <span className={`badge ${isPublic ? "badge-public" : ""}`}>{isPublic ? "Public" : "Private"}</span>
      </h2>
      <p className="muted small">
        A public grant lets everyone signed in on this server read the channels it names without being a member. They need the board's address,
        they only read (no posts, reactions or follows), and they never see the members, private channels or settings. Their agents read it once
        they save the board.
      </p>
      {channels !== null && (
        <p>
          {open.length ? (
            <>
              People who are not members can read: <strong>{channelNames(open)}</strong>.
            </>
          ) : isPublic ? (
            "A public grant is in place, and no channel it names exists yet."
          ) : (
            "No channel is public: only members read this board."
          )}
        </p>
      )}
      {publicGrants.length > 0 && (
        <ul className="rows grant-rows" aria-label="Public grants">
          {publicGrants.map((g) => (
            <li key={g.id} className="row grant-row">
              <div className="row-main">
                <div className="grant-who">The public</div>
                <ul className="grant-can">
                  {Object.entries(g.can).map(([pattern, perms]) => (
                    <li key={pattern}>
                      <code>{pattern}</code> <span className={perms.length ? "" : "warn-text"}>{perms.length ? "read" : "closed"}</span>
                    </li>
                  ))}
                </ul>
                <div className="muted small mono">{g.id}</div>
              </div>
              {isOwner && (
                <div className="row-actions">
                  <button type="button" className="button button-small button-danger" onClick={() => onRevoke(g)}>
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!isOwner ? (
        <p className="hint">Only the board's owner opens it to the public or closes it.</p>
      ) : offered === false ? (
        <p className="note">This server does not offer public access.</p>
      ) : offered ? (
        <PublicGrantForm grants={grants} channels={channels ?? []} onCreated={onChanged} />
      ) : null}
    </section>
  );
}

type PublicRow = { pattern: string; read: boolean };

/** Makes a public grant: `read` (or nothing, to leave a subtree out) at each pattern, after a confirmation that names what opens. */
function PublicGrantForm({ grants, channels, onCreated }: { grants: Grant[]; channels: Channel[]; onCreated: () => void }) {
  const { board } = useBoard();
  const id = useId();
  const toast = useToast();
  const [rows, setRows] = useState<PublicRow[]>([{ pattern: "", read: true }]);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<CreateGrantInput | null>(null);
  const setRow = (i: number, row: Partial<PublicRow>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...row } : r)));

  function review(e: FormEvent) {
    e.preventDefault();
    const can: CreateGrantInput["can"] = {};
    for (const r of rows) {
      const p = r.pattern.trim();
      if (!PATTERN_RE.test(p)) return setError(new Error(`"${p || "(empty)"}" isn't *, a channel, or a subtree ending in /.`));
      if (p in can) return setError(new Error(`${p} is listed twice.`));
      can[p] = r.read ? ["read"] : "none";
    }
    if (!rows.some((r) => r.read)) return setError(new Error("Give read at one pattern at least; a grant that only closes opens nothing."));
    setError(null);
    setConfirming({ principals: [{ kind: "public" }], can });
  }

  // What the grant would change among the channels that exist now, by the server's rule.
  const proposed: GrantLike | null = confirming ? { principals: confirming.principals, can: Object.fromEntries(Object.entries(confirming.can).map(([p, v]) => [p, v === "none" ? [] : (["read"] as Permission[])])) } : null;
  const after = proposed ? channels.filter((c) => publicCanRead([...grants, proposed], c.path)) : [];
  const opens = after.filter((c) => !c.public);
  const closes = proposed ? channels.filter((c) => c.public && !after.includes(c)) : [];
  // Private channels a pattern covers and still leaves closed: a wider pattern does not open what is closed closer by.
  const stillPrivate = proposed ? channels.filter((c) => c.private && !after.includes(c) && Object.entries(proposed.can).some(([p, perms]) => perms.length > 0 && covers(p, c.path))) : [];
  const patterns = proposed ? Object.entries(proposed.can).filter(([, perms]) => perms.length > 0).map(([p]) => p) : [];
  const leftOut = proposed ? Object.entries(proposed.can).filter(([, perms]) => perms.length === 0).map(([p]) => p) : [];
  const codes = (list: string[]) =>
    list.map((p, i) => (
      <span key={p}>
        {i > 0 && ", "}
        <code>{p}</code>
      </span>
    ));

  return (
    <>
      <form className="stack public-grant-form" onSubmit={review} aria-label="Open channels to the public">
        <h3>Open channels to the public</h3>
        {rows.map((r, i) => (
          <div key={i} className="grant-pattern-row">
            <div className="field">
              <label htmlFor={`${id}-p${i}`}>Pattern</label>
              <input id={`${id}-p${i}`} value={r.pattern} placeholder="announcements/" onChange={(e) => setRow(i, { pattern: e.target.value.toLowerCase() })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-r${i}`}>The public can</label>
              <select id={`${id}-r${i}`} value={r.read ? "read" : "none"} onChange={(e) => setRow(i, { read: e.target.value === "read" })}>
                <option value="read">Read</option>
                <option value="none">Nothing (leave it out)</option>
              </select>
            </div>
            {rows.length > 1 && (
              <button type="button" className="link-button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className="button button-small" onClick={() => setRows((all) => [...all, { pattern: "", read: false }])}>
          Add pattern
        </button>
        <p className="hint">
          <code>announcements</code> is that channel only, <code>announcements/</code> is it and everything under it, <code>*</code> is every
          channel. A private channel stays private under <code>*</code>: it opens only when you name it. Use “Nothing” to leave a subtree out of a
          wider pattern.
        </p>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="submit" className="button button-primary">
            Review and open
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={!!confirming}
        title="Open this to the public?"
        confirmLabel="Open to the public"
        body={
          <div className="stack">
            <p>
              Everyone signed in on this server, member or not, will be able to read {codes(patterns)} on {board.name}
              {leftOut.length > 0 && <> (leaving out {codes(leftOut)})</>}: every thread and message there, those already posted included, and
              whatever is posted later.
            </p>
            {opens.length > 0 ? (
              <p>
                Channels this opens now: <strong>{channelNames(opens)}</strong>.
              </p>
            ) : (
              <p>No channel that exists now is opened by it. Channels created later that match will be public from their first post.</p>
            )}
            {closes.length > 0 && (
              <p>
                It closes to the public: <strong>{channelNames(closes)}</strong>.
              </p>
            )}
            {stillPrivate.length > 0 && <p className="muted small">Still private, because nothing names them: {channelNames(stillPrivate)}.</p>}
            <p className="muted small">
              Readers who are not members can't post, react or see the members. You can revoke the grant at any time; what was read or copied
              meanwhile can't be taken back.
            </p>
          </div>
        }
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if (!confirming) return;
          await api.createGrant(board.id, confirming);
          toast("Public grant added", "success");
          setRows([{ pattern: "", read: true }]);
          onCreated();
        }}
      />
    </>
  );
}

type Row = { pattern: string; perms: Permission[] };

/** Creates a grant, or edits one: who it names and what it gives at each pattern. */
function GrantForm({ grant, onSaved }: { grant?: Grant; onSaved: () => void }) {
  const { board, members } = useBoard();
  const id = useId();
  const toast = useToast();
  const [groups, setGroups] = useState<Set<string>>(new Set(grant?.principals.filter((p) => p.kind !== "member").map((p) => p.kind) ?? []));
  const [picked, setPicked] = useState<Set<string>>(new Set(grant?.principals.flatMap((p) => (p.kind === "member" ? [p.principal_id] : [])) ?? []));
  const [rows, setRows] = useState<Row[]>(grant ? Object.entries(grant.can).map(([pattern, perms]) => ({ pattern, perms })) : [{ pattern: "", perms: ["read", "post", "react", "label"] }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const toggle = (set: Set<string>, value: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };
  const setRow = (i: number, row: Partial<Row>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...row } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const principals: GrantPrincipal[] = [
      ...[...picked].map((principal_id) => ({ kind: "member" as const, principal_id })),
      ...[...groups].map((kind) => ({ kind }) as GrantPrincipal),
    ];
    if (principals.length === 0) return setError(new Error("Choose who the grant is for."));
    const can: CreateGrantInput["can"] = {};
    for (const r of rows) {
      const p = r.pattern.trim();
      if (!PATTERN_RE.test(p)) return setError(new Error(`"${p || "(empty)"}" isn't *, a channel, or a subtree ending in /.`));
      can[p] = r.perms.length ? r.perms : "none";
    }
    setBusy(true);
    setError(null);
    try {
      if (grant) {
        const before = new Set(grant.principals.map((p) => (p.kind === "member" ? `m:${p.principal_id}` : p.kind)));
        const after = new Set(principals.map((p) => (p.kind === "member" ? `m:${p.principal_id}` : p.kind)));
        const add = principals.filter((p) => !before.has(p.kind === "member" ? `m:${p.principal_id}` : p.kind));
        const remove = grant.principals.filter((p) => !after.has(p.kind === "member" ? `m:${p.principal_id}` : p.kind));
        await api.updateGrant(grant.id, { can, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) });
        toast("Grant updated", "success");
      } else {
        await api.createGrant(board.id, { principals, can });
        toast("Grant added", "success");
        setGroups(new Set());
        setPicked(new Set());
        setRows([{ pattern: "", perms: ["read", "post", "react", "label"] }]);
      }
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={grant ? "stack" : "card stack"} onSubmit={submit} aria-label={grant ? "Edit grant" : "Add a grant"}>
      {!grant && <h2 className="card-title">Add a grant</h2>}
      <fieldset className="grant-principals">
        <legend>Who</legend>
        <div className="checkbox-grid">
          {GROUPS.map((g) => (
            <label key={g.kind} className="checkbox">
              <input type="checkbox" checked={groups.has(g.kind)} onChange={(e) => setGroups(toggle(groups, g.kind, e.target.checked))} />
              <span>
                {g.label}
                <span className="hint block">{g.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="checkbox-grid">
          {members.map((m) => (
            <label key={m.principal.id} className="checkbox">
              <input type="checkbox" checked={picked.has(m.principal.id)} onChange={(e) => setPicked(toggle(picked, m.principal.id, e.target.checked))} />
              <span>
                @{m.handle}
                <span className="hint block">
                  {m.principal.display_name} · {m.role}
                  {m.principal.kind === "agent" ? " · agent" : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="hint">A grant to a person also reaches the agents that act for them; an agent never gets more than its person.</p>
      </fieldset>
      <fieldset>
        <legend>Where and what</legend>
        {rows.map((r, i) => (
          <div key={i} className="grant-pattern-row">
            <div className="field">
              <label htmlFor={`${id}-p${i}`}>Pattern</label>
              <input id={`${id}-p${i}`} value={r.pattern} placeholder="security/" onChange={(e) => setRow(i, { pattern: e.target.value.toLowerCase() })} />
            </div>
            <div className="perm-checks" role="group" aria-label={`Permissions at ${r.pattern || "this pattern"}`}>
              {PERMS.map((p) => (
                <label key={p} className="checkbox inline">
                  <input
                    type="checkbox"
                    checked={r.perms.includes(p)}
                    onChange={(e) => setRow(i, { perms: e.target.checked ? PERMS.filter((x) => x === p || r.perms.includes(x)) : r.perms.filter((x) => x !== p) })}
                  />
                  <span>{p}</span>
                </label>
              ))}
              {r.perms.length === 0 && <span className="warn-text small">closes it</span>}
            </div>
            {rows.length > 1 && (
              <button type="button" className="link-button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className="button button-small" onClick={() => setRows((all) => [...all, { pattern: "", perms: ["read"] }])}>
          Add pattern
        </button>
        <p className="hint">
          <code>*</code> is every channel, <code>security/</code> is security and everything under it, <code>security</code> is that channel only.
          Uncheck everything to close a pattern. Add the grant that keeps you in before closing a channel to everyone.
        </p>
      </fieldset>
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : grant ? "Save grant" : "Add grant"}
        </button>
      </div>
    </form>
  );
}

/** Which grant decides what someone can do in a channel. */
function ExplainCard() {
  const { board, members, meId } = useBoard();
  const ids = { channel: useId(), who: useId() };
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [who, setWho] = useState(meId);
  const [result, setResult] = useState<AccessExplanation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = channelError(channel.trim());
    if (problem) return setError(new Error(problem));
    setBusy(true);
    setError(null);
    try {
      setResult(await api.explainAccess(board.id, channel.trim(), who === meId ? undefined : who));
    } catch (err) {
      setResult(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card explain-card" aria-labelledby="explain-title">
      <h2 id="explain-title" className="card-title">
        Explain access
      </h2>
      <form className="inline-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={ids.who}>Member</label>
          <select id={ids.who} value={who} onChange={(e) => setWho(e.target.value)}>
            {members.map((m) => (
              <option key={m.principal.id} value={m.principal.id}>
                {m.principal.id === meId ? "You" : `@${m.handle}`} ({m.role})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.channel}>Channel</label>
          <input id={ids.channel} value={channel} onChange={(e) => setChannel(e.target.value.toLowerCase())} placeholder="security/incidents" />
        </div>
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Checking…" : "Explain"}
        </button>
      </form>
      <p className="hint">Anyone can explain their own access. Explaining someone else's needs manage at every channel.</p>
      <ErrorNote error={error} />
      {result && (
        <div className="explain-result" role="status">
          <p>
            <strong>{result.principal.display_name}</strong> ({result.role}) in <code>{result.channel}</code> can{" "}
            <strong>{permsText(result.can)}</strong>.
          </p>
          <ul className="small">
            <li>
              {result.pattern ? (
                <>
                  Decided by {result.grant_ids.join(", ")} at <code>{result.pattern}</code> ({result.level?.replace("_", " ")}), which gives{" "}
                  {permsText(result.granted)}.
                </>
              ) : (
                <>No grant applies, so the {result.role} role's defaults hold: {permsText(result.granted)}.</>
              )}
            </li>
            <li>
              The {result.role} role allows at most {permsText(result.role_cap)}.
            </li>
            {result.person_cap && <li>The person this agent acts for can do {permsText(result.person_cap)} here.</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

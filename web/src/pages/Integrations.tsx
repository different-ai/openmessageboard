import type { Integration, SyncPlatform } from "@openmessageboard/protocol";
import { useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { useBoard } from "../board";
import { formatDateTime } from "../format";
import { useTitle } from "../router";
import { ConfirmDialog, CopyField, Empty, ErrorNote, Field, Loading, PlatformName, TimeAgo, useLoad, useToast } from "../ui";
import { OwnerOnly } from "./OwnerOnly";

type FieldDef = { key: string; label: string; placeholder?: string; pattern?: string; hint?: string };
type PlatformDef = { label: string; config: FieldDef[]; secrets: FieldDef[]; setup: string };

/** Field names sent in `config` and `secrets` for each platform. */
export const PLATFORMS: Record<SyncPlatform, PlatformDef> = {
  slack: {
    label: "Slack",
    config: [{ key: "channel_id", label: "Channel ID", placeholder: "C0123456789", hint: "In Slack: channel details → About → Channel ID." }],
    secrets: [
      { key: "bot_token", label: "Bot token", placeholder: "xoxb-…" },
      { key: "signing_secret", label: "Signing secret", hint: "Slack app → Basic Information → App Credentials." },
    ],
    setup: "In your Slack app, open Event Subscriptions, turn them on, and paste the webhook URL as the Request URL. Subscribe to message.channels and invite the app to the channel.",
  },
  github: {
    label: "GitHub",
    config: [{ key: "repo", label: "Repository", placeholder: "owner/name", pattern: "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+" }],
    secrets: [
      { key: "token", label: "Token", hint: "A fine-grained token with Issues read and write on this repository." },
      { key: "webhook_secret", label: "Webhook secret", hint: "Any long random string. Use the same value in GitHub." },
    ],
    setup: "In the repository, open Settings → Webhooks → Add webhook. Paste the webhook URL as the Payload URL, choose application/json, enter the same webhook secret, and select Issues and Issue comments.",
  },
  linear: {
    label: "Linear",
    config: [{ key: "team_key", label: "Team key", placeholder: "ENG", hint: "The prefix of the team's issue identifiers." }],
    secrets: [
      { key: "api_key", label: "API key", hint: "Linear → Settings → Security & access → Personal API keys." },
      { key: "webhook_secret", label: "Webhook secret", hint: "Shown when you create the webhook in Linear." },
    ],
    setup: "In Linear, open Settings → API → Webhooks → New webhook. Paste the webhook URL, pick the team, and select Issues and Comments.",
  },
};

export function Integrations() {
  const { board, isOwner } = useBoard();
  useTitle(`Integrations · ${board.name}`);
  const { data, setData, error, loading } = useLoad(
    () => (isOwner ? api.integrations(board.id) : Promise.resolve({ integrations: [] })),
    [board.id, isOwner],
  );
  const [justCreated, setJustCreated] = useState<Integration | null>(null);
  if (!isOwner) return <OwnerOnly what="integrations" />;
  const list = data?.integrations ?? [];

  return (
    <div className="page-section">
      <h1 className="page-title">Integrations</h1>
      <p className="muted">
        Sync threads with a Slack channel, GitHub issues or Linear issues. Synced messages show the original author and a link
        back, like “Ada · Slack”. Secrets are stored encrypted and never shown again.
      </p>
      <AddIntegration
        boardId={board.id}
        onCreated={(i) => {
          setJustCreated(i);
          setData({ integrations: [i, ...list] });
        }}
      />
      {justCreated && (
        <div className="card note-success-card" role="status">
          <h2>Finish setting up {justCreated.name}</h2>
          <p>{PLATFORMS[justCreated.platform].setup}</p>
          <CopyField label="Webhook URL" value={justCreated.webhook_url} />
          <button type="button" className="button button-small" onClick={() => setJustCreated(null)}>
            Done
          </button>
        </div>
      )}
      <section aria-labelledby="int-list">
        <h2 id="int-list" className="section-title">
          Connected <span className="count">{list.length}</span>
        </h2>
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty title="No integrations yet">
            <p>Add one above. Owners can then link any thread from the thread page.</p>
          </Empty>
        ) : (
          <ul className="cards-list">
            {list.map((i) => (
              <IntegrationCard key={i.id} i={i} onDeleted={() => setData({ integrations: list.filter((x) => x.id !== i.id) })} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function IntegrationCard({ i, onDeleted }: { i: Integration; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const summary = Object.entries(i.config)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
    .join(" · ");
  return (
    <li className="card integration">
      <div className="card-head">
        <h3>
          <span className={`platform-tag platform-${i.platform}`}>
            <PlatformName platform={i.platform} />
          </span>{" "}
          {i.name}
        </h3>
        <button type="button" className="button button-small button-danger-quiet" onClick={() => setConfirm(true)}>
          Delete
        </button>
      </div>
      {summary && <p className="mono small">{summary}</p>}
      <CopyField label="Webhook URL" value={i.webhook_url} />
      <dl className="facts">
        <div>
          <dt>Last event</dt>
          <dd>{i.last_event_at ? <TimeAgo iso={i.last_event_at} /> : <span className="muted">None yet</span>}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{formatDateTime(i.created_at)}</dd>
        </div>
      </dl>
      {i.last_error && (
        <p className="note note-error" role="note">
          Last error: {i.last_error}
        </p>
      )}
      <details className="setup-help">
        <summary>Setup steps</summary>
        <p>{PLATFORMS[i.platform].setup}</p>
      </details>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${i.name}?`}
        body={<p>Sync stops and links from threads to {PLATFORMS[i.platform].label} are removed. Messages already synced stay.</p>}
        confirmLabel="Delete integration"
        onConfirm={async () => {
          await api.deleteIntegration(i.id);
          onDeleted();
          toast("Integration deleted.", "success");
        }}
      />
    </li>
  );
}

function AddIntegration({ boardId, onCreated }: { boardId: string; onCreated: (i: Integration) => void }) {
  const baseId = useId();
  const [platform, setPlatform] = useState<SyncPlatform>("slack");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const def = PLATFORMS[platform];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const pick = (fields: FieldDef[]) => Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? "").trim()]));
    try {
      const { integration } = await api.createIntegration(boardId, {
        platform,
        name: name.trim() || def.label,
        config: pick(def.config),
        secrets: pick(def.secrets),
      });
      setValues({});
      setName("");
      onCreated(integration);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const input = (f: FieldDef, secret: boolean) => {
    const id = `${baseId}-${f.key}`;
    return (
      <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint}>
        <input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          spellCheck={false}
          required
          pattern={f.pattern}
          placeholder={f.placeholder}
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      </Field>
    );
  };

  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="add-int-title">
      <h2 id="add-int-title">Add an integration</h2>
      <fieldset className="segmented-field">
        <legend>Platform</legend>
        <div className="segmented">
          {(Object.keys(PLATFORMS) as SyncPlatform[]).map((p) => (
            <label key={p} className={`seg-radio ${platform === p ? "selected" : ""}`}>
              <input
                type="radio"
                name="platform"
                value={p}
                checked={platform === p}
                onChange={() => {
                  setPlatform(p);
                  setValues({});
                }}
              />
              {PLATFORMS[p].label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid-2">
        <Field label="Name" htmlFor={`${baseId}-name`} hint="Shown to the owner only.">
          <input id={`${baseId}-name`} value={name} maxLength={60} placeholder={def.label} onChange={(e) => setName(e.target.value)} />
        </Field>
        {def.config.map((f) => input(f, false))}
      </div>
      <div className="grid-2">{def.secrets.map((f) => input(f, true))}</div>
      <ErrorNote error={error} />
      <div className="actions start">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Adding…" : `Add ${def.label}`}
        </button>
      </div>
    </form>
  );
}

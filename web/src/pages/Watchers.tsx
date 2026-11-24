import { EVENT_TYPES, type EventType, type Watcher, type WatcherFilter } from "@openmessageboard/protocol";
import { useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { useBoard } from "../board";
import { formatDateTime, parseLabels } from "../format";
import { useTitle } from "../router";
import { ConfirmDialog, CopyField, Empty, ErrorNote, Field, LabelChips, Loading, TimeAgo, useLoad, useToast } from "../ui";
import { OwnerOnly } from "./OwnerOnly";

function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

const SOURCES: [string, string][] = [
  ["", "Any source"],
  ["board", "This board"],
  ["slack", "Slack"],
  ["github", "GitHub"],
  ["linear", "Linear"],
];

const REASONS: Record<string, string> = {
  ownership_ended: "you no longer own this board",
  principal_disabled: "your account was disabled",
  board_disabled: "the board was disabled",
  gone: "the endpoint answered 410 Gone",
  access_ended: "access ended",
  invalid_filter: "its filter no longer applies",
};

export function Watchers() {
  const { board, isOwner } = useBoard();
  useTitle(`Watchers · ${board.name}`);
  const { data, setData, error, loading, reload } = useLoad(
    (signal) => (isOwner ? api.watchers(board.id, signal) : Promise.resolve({ watchers: [] as Watcher[] })),
    [board.id, isOwner],
  );
  if (!isOwner) return <OwnerOnly what="watchers" />;
  const watchers = data?.watchers ?? [];
  return (
    <div className="page-section">
      <h1 className="page-title">Watchers</h1>
      <p className="muted">
        A watcher sends each change on this board that matches its filter to your HTTPS endpoint, signed with Standard Webhooks.
        Your endpoint answers a verification challenge once, then receives <code>{`{"type": "change", "watcher_id", "change"}`}</code>.
      </p>
      <AddWatcher boardId={board.id} onCreated={(w) => setData({ watchers: [...watchers, w] })} />
      <section aria-labelledby="watcher-list">
        <div className="toolbar">
          <h2 id="watcher-list" className="section-title">
            Watchers <span className="count">{watchers.length}</span>
          </h2>
          <button type="button" className="button button-small toolbar-end" onClick={reload}>
            Refresh
          </button>
        </div>
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : watchers.length === 0 ? (
          <Empty title="No watchers yet" />
        ) : (
          <ul className="cards-list">
            {watchers.map((w) => (
              <WatcherCard key={w.id} w={w} onDeleted={() => setData({ watchers: watchers.filter((x) => x.id !== w.id) })} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function filterSummary(f: WatcherFilter, names: Map<string, string>): string[] {
  const parts: string[] = [];
  if (f.types) parts.push(`Types: ${f.types.join(", ")}`);
  if (f.channel) parts.push(`Channel: ${f.channel}`);
  if (f.thread) parts.push(`Thread: ${f.thread}`);
  if (f.by) parts.push(`By: ${names.get(f.by) ?? f.by}`);
  if (f.mentions) parts.push(`Mentions: ${names.get(f.mentions) ?? f.mentions}`);
  if (f.text) parts.push(`Text contains “${f.text}”`);
  if (f.source) parts.push(`Source: ${f.source}`);
  return parts;
}

function WatcherCard({ w, onDeleted }: { w: Watcher; onDeleted: () => void }) {
  const { members } = useBoard();
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const names = new Map(members.map((m) => [m.principal.id, `@${m.handle}`]));
  const summary = filterSummary(w.filter, names);
  return (
    <li className="card watcher">
      <div className="card-head">
        <h3 className="mono watcher-url">{w.url}</h3>
        <span className={`badge ${w.status === "active" ? "badge-success" : "badge-muted"}`}>{w.status}</span>
        <button type="button" className="button button-small button-danger-quiet" onClick={() => setConfirm(true)}>
          Delete
        </button>
      </div>
      {w.status === "stopped" && (
        <p className="note note-warning compact">Stopped because {REASONS[w.stopped_reason ?? ""] ?? w.stopped_reason ?? "of an error"}.</p>
      )}
      <p className="small">{summary.length ? summary.join(" · ") : "Every change on the board"}</p>
      {w.filter.labels && <LabelChips labels={w.filter.labels} />}
      <h4 className="small">Recent deliveries</h4>
      {w.recent_deliveries.length === 0 ? (
        <p className="muted small">Nothing delivered yet.</p>
      ) : (
        <table className="delivery-table">
          <thead>
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {w.recent_deliveries.map((d) => (
              <tr key={d.id}>
                <td className="mono">
                  {d.change_type} #{d.change_seq}
                </td>
                <td>
                  <span className={`delivery-${d.status}`}>{d.status}</span>
                  {d.last_error && <span className="muted"> ({d.last_error})</span>}
                </td>
                <td>{d.attempts}</td>
                <td>
                  <TimeAgo iso={d.delivered_at ?? d.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Added {formatDateTime(w.created_at)}</p>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this watcher?"
        body={<p>Deliveries to {w.url} stop, and pending deliveries are dropped.</p>}
        confirmLabel="Delete watcher"
        onConfirm={async () => {
          await api.deleteWatcher(w.id);
          onDeleted();
          toast("Watcher deleted.", "success");
        }}
      />
    </li>
  );
}

function AddWatcher({ boardId, onCreated }: { boardId: string; onCreated: (w: Watcher) => void }) {
  const { members } = useBoard();
  const ids = { url: useId(), by: useId(), mentions: useId(), labels: useId(), text: useId(), source: useId(), thread: useId(), channel: useId() };
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState(newSecret);
  const [types, setTypes] = useState<EventType[]>(["thread.created", "message.created"]);
  const [by, setBy] = useState("");
  const [mentions, setMentions] = useState("");
  const [labels, setLabels] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [thread, setThread] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const sorted = [...members].sort((a, b) => a.handle.localeCompare(b.handle));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseLabels(labels);
    if (parsed.error) return setError(new Error(parsed.error));
    const filter: WatcherFilter = {};
    if (types.length && types.length < EVENT_TYPES.length) filter.types = types;
    if (by) filter.by = by;
    if (mentions) filter.mentions = mentions;
    if (Object.keys(parsed.labels).length) filter.labels = parsed.labels;
    if (text.trim()) filter.text = text.trim();
    if (source) filter.source = source as WatcherFilter["source"];
    if (thread.trim()) filter.thread = thread.trim();
    if (channel.trim()) filter.channel = channel.trim();
    setBusy(true);
    try {
      const { watcher } = await api.createWatcher(boardId, { url: url.trim(), secret, filter });
      onCreated(watcher);
      toast("Watcher added. Keep the signing secret to verify deliveries.", "success");
      setUrl("");
      setSecret(newSecret());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (t: EventType) => setTypes((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="add-watcher-title">
      <h2 id="add-watcher-title">Add a watcher</h2>
      <Field label="Endpoint URL" htmlFor={ids.url} hint="HTTPS. It must answer the verification challenge with the same challenge value.">
        <input id={ids.url} type="url" required className="mono" value={url} placeholder="https://hooks.example.com/omb" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <div className="secret-row">
        <CopyField label="Signing secret" value={secret} secret />
        <button type="button" className="button button-small" onClick={() => setSecret(newSecret())}>
          New secret
        </button>
      </div>
      <fieldset>
        <legend>Change types</legend>
        <div className="type-grid">
          {EVENT_TYPES.map((t) => (
            <label key={t} className="checkbox inline">
              <input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} />
              <span className="mono small">{t}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid-2">
        <Field label="By (optional)" htmlFor={ids.by} hint="A person covers their agents.">
          <select id={ids.by} value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="">Anyone</option>
            {sorted.map((m) => (
              <option key={m.principal.id} value={m.principal.id}>
                @{m.handle}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mentions (optional)" htmlFor={ids.mentions}>
          <select id={ids.mentions} value={mentions} onChange={(e) => setMentions(e.target.value)}>
            <option value="">Anyone or no one</option>
            {sorted.map((m) => (
              <option key={m.principal.id} value={m.principal.id}>
                @{m.handle}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Thread labels (optional)" htmlFor={ids.labels} hint="key=value, comma-separated; every one must match.">
          <input id={ids.labels} className="mono" value={labels} placeholder="kind=bug" onChange={(e) => setLabels(e.target.value)} />
        </Field>
        <Field label="Text contains (optional)" htmlFor={ids.text}>
          <input id={ids.text} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Source" htmlFor={ids.source}>
          <select id={ids.source} value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="One thread (optional)" htmlFor={ids.thread} hint="A thread ID or any message ID in it.">
          <input id={ids.thread} className="mono" value={thread} onChange={(e) => setThread(e.target.value)} />
        </Field>
      </div>
      <Field label="Channel (optional)" htmlFor={ids.channel} hint="A channel, or end with / for it and everything under it.">
        <input id={ids.channel} className="mono" value={channel} placeholder="dev/" onChange={(e) => setChannel(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <div className="actions start">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Verifying…" : "Add watcher"}
        </button>
      </div>
    </form>
  );
}

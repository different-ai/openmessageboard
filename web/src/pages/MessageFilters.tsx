import type { Change, Labels, Member, Message } from "@openmessageboard/protocol";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useBoard, useBoardChanges } from "../board";
import { excerpt } from "../markdown";
import { Link, navigate } from "../router";
import { Author, Empty, ErrorNote, Loading, PlatformName, TimeAgo } from "../ui";

/** Message filters kept in the board URL: `by`, `mentions=me`, `text`, `source`. */
export type MessageFilters = { by: string; mentionsMe: boolean; text: string; source: string };

const KEYS = ["by", "mentions", "text", "source"] as const;
const SOURCES: [string, string][] = [
  ["", "Any source"],
  ["board", "This board"],
  ["slack", "Slack"],
  ["github", "GitHub"],
  ["linear", "Linear"],
];

export function readMessageFilters(search: string): MessageFilters {
  const p = new URLSearchParams(search);
  return { by: p.get("by") ?? "", mentionsMe: p.get("mentions") === "me", text: p.get("text") ?? "", source: p.get("source") ?? "" };
}

export function hasMessageFilters(f: MessageFilters): boolean {
  return !!(f.by || f.mentionsMe || f.text || f.source);
}

/** Keeps the message filters of `search` on an href built from the thread filters. */
export function withMessageFilters(href: string, search: string): string {
  const from = new URLSearchParams(search);
  const [path, query = ""] = href.split("?");
  const to = new URLSearchParams(query);
  for (const k of KEYS) {
    const v = from.get(k);
    if (v) to.set(k, v);
  }
  const s = to.toString();
  return `${path}${s ? `?${s}` : ""}`;
}

function setParams(boardId: string, search: string, f: MessageFilters) {
  const p = new URLSearchParams(search);
  for (const k of KEYS) p.delete(k);
  if (f.by) p.set("by", f.by);
  if (f.mentionsMe) p.set("mentions", "me");
  if (f.text.trim()) p.set("text", f.text.trim());
  if (f.source) p.set("source", f.source);
  const s = p.toString();
  navigate(`/b/${boardId}${s ? `?${s}` : ""}`, { replace: true });
}

export function MessageFilterBar({ boardId, search, members, filters }: { boardId: string; search: string; members: Member[]; filters: MessageFilters }) {
  const ids = { by: useId(), text: useId(), source: useId(), mentions: useId() };
  const [text, setText] = useState(filters.text);
  useEffect(() => setText(filters.text), [filters.text]);
  const update = (patch: Partial<MessageFilters>) => setParams(boardId, search, { ...filters, ...patch });
  function submitText(e: FormEvent) {
    e.preventDefault();
    update({ text });
  }
  const sorted = [...members].sort((a, b) => a.handle.localeCompare(b.handle));
  return (
    <form className="message-filters" role="search" aria-label="Filter messages" onSubmit={submitText}>
      <label htmlFor={ids.by} className="label-filter-label">
        By
      </label>
      <select id={ids.by} value={filters.by} onChange={(e) => update({ by: e.target.value })}>
        <option value="">Anyone</option>
        <option value="me">Me (and my agents)</option>
        {sorted.map((m) => (
          <option key={m.principal.id} value={m.handle}>
            @{m.handle}
            {m.principal.via ? ` (via ${m.principal.via.display_name})` : ""}
          </option>
        ))}
      </select>
      <label className="checkbox inline" htmlFor={ids.mentions}>
        <input id={ids.mentions} type="checkbox" checked={filters.mentionsMe} onChange={(e) => update({ mentionsMe: e.target.checked })} />
        <span>Mentions me</span>
      </label>
      <label htmlFor={ids.text} className="label-filter-label">
        Text
      </label>
      <input id={ids.text} type="search" value={text} maxLength={200} placeholder="contains…" onChange={(e) => setText(e.target.value)} onBlur={() => text !== filters.text && update({ text })} />
      <label htmlFor={ids.source} className="visually-hidden">
        Source
      </label>
      <select id={ids.source} value={filters.source} onChange={(e) => update({ source: e.target.value })}>
        {SOURCES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <button type="submit" className="button button-small">
        Apply
      </button>
      {hasMessageFilters(filters) && (
        <button type="button" className="link-button" onClick={() => setParams(boardId, search, { by: "", mentionsMe: false, text: "", source: "" })}>
          Clear
        </button>
      )}
    </form>
  );
}

/** Matching messages (read_messages), newest first, refreshed as the board changes. */
export function FilteredMessages({ filters, labels, channel }: { filters: MessageFilters; labels: Labels; channel?: string | undefined }) {
  const { board } = useBoard();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = JSON.stringify([filters, labels, channel]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api.messages(
          board.id,
          {
            channel: channel || undefined,
            by: filters.by || undefined,
            mentions: filters.mentionsMe ? "me" : undefined,
            text: filters.text || undefined,
            source: filters.source || undefined,
            labels: Object.keys(labels).length ? labels : undefined,
            limit: 100,
          },
          signal,
        );
        setMessages([...res.messages].reverse());
        setMore(res.has_more);
        setError(null);
      } catch (e) {
        if (!signal?.aborted) setError(e);
      }
    },
    // key captures every filter value
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.id, key],
  );

  useEffect(() => {
    const ctl = new AbortController();
    setMessages(null);
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onChange = useCallback(
    (c: Change) => {
      if (!c.message && c.type !== "thread.updated") return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 300);
    },
    [load],
  );
  const onResync = useCallback(() => void load(), [load]);
  useBoardChanges(onChange, onResync);

  if (error) return <ErrorNote error={error} />;
  if (messages === null) return <Loading label="Finding messages…" />;
  if (messages.length === 0)
    return (
      <Empty title="No messages match">
        <p>Try fewer filters.</p>
      </Empty>
    );
  return (
    <>
      <ul className="message-results" aria-label="Matching messages">
        {messages.map((m) => (
          <li key={m.id} className="message-result">
            <div className="thread-row-meta">
              <Author p={m.author} />
              <TimeAgo iso={m.created_at} />
              {m.source && (
                <span className={`platform-tag platform-${m.source.platform}`}>
                  <PlatformName platform={m.source.platform} />
                </span>
              )}
            </div>
            <p className="message-result-body">{m.deleted ? <span className="muted">Deleted message</span> : excerpt(m.body, 280)}</p>
            <Link to={`/b/${board.id}/t/${m.thread_id}#m-${m.id}`} className="small">
              View in thread
            </Link>
          </li>
        ))}
      </ul>
      {more && <p className="hint center">Showing the latest 100 matches. Narrow the filters to see older ones.</p>}
    </>
  );
}

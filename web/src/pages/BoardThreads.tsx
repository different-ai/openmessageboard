import type { Change, Labels, Thread } from "@openmessageboard/protocol";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, isApiError, type ThreadQuery } from "../api";
import { useBoard, useBoardChanges } from "../board";
import { MarkdownEditor, extractMentions, useIdempotencyKey } from "../composer";
import { MAX_TITLE, parseLabels, plural } from "../format";
import { Link, navigate, useLocation, useTitle } from "../router";
import { useSession } from "../session";
import { Author, CopyField, Empty, ErrorNote, LabelChips, Loading, PlatformName, TaskBadge, TimeAgo, errorText, useToast } from "../ui";

type Filters = { filter: "all" | "following" | "unread"; kind: "all" | "discussion" | "task"; labels: Labels };

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const filter = p.get("filter");
  const kind = p.get("kind");
  return {
    filter: filter === "following" || filter === "unread" ? filter : "all",
    kind: kind === "discussion" || kind === "task" ? kind : "all",
    labels: parseLabels(p.getAll("label").join(",")).labels,
  };
}

function filtersHref(boardId: string, f: Filters) {
  const p = new URLSearchParams();
  if (f.filter !== "all") p.set("filter", f.filter);
  if (f.kind !== "all") p.set("kind", f.kind);
  for (const [k, v] of Object.entries(f.labels)) p.append("label", `${k}=${v}`);
  const s = p.toString();
  return `/b/${boardId}${s ? `?${s}` : ""}`;
}

export function matchesFilters(t: Thread, f: Pick<Filters, "kind" | "labels"> & { filter?: Filters["filter"] }): boolean {
  if (f.kind !== "all" && t.kind !== f.kind) return false;
  if (f.filter === "following" && !t.following) return false;
  if (f.filter === "unread" && t.unread_count === 0) return false;
  return Object.entries(f.labels).every(([k, v]) => t.labels[k] === v);
}

const byActivity = (a: Thread, b: Thread) => b.last_activity_at.localeCompare(a.last_activity_at);

/** Applies one live change to a list of threads. */
export function applyThreadChange(list: Thread[], c: Change, matches: (t: Thread) => boolean, meId: string): Thread[] {
  if (c.thread) {
    const t = c.thread;
    const rest = list.filter((x) => x.id !== t.id);
    return matches(t) ? [t, ...rest].sort(byActivity) : rest;
  }
  if (c.type === "message.created" && c.thread_id) {
    return list
      .map((x) =>
        x.id === c.thread_id
          ? {
              ...x,
              message_count: x.message_count + 1,
              last_activity_at: c.created_at,
              unread_count: x.unread_count + (c.actor?.id === meId ? 0 : 1),
            }
          : x,
      )
      .sort(byActivity);
  }
  return list;
}

export function BoardThreads() {
  const { board, live, canWrite, members, meId } = useBoard();
  const { search } = useLocation();
  const filters = readFilters(search);
  const filterKey = filtersHref(board.id, filters);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composing, setComposing] = useState(false);
  useTitle(board.name);

  const query = useCallback(
    (page_cursor?: string): ThreadQuery => ({
      filter: filters.filter,
      kind: filters.kind === "all" ? undefined : filters.kind,
      labels: Object.keys(filters.labels).length ? filters.labels : undefined,
      page_cursor,
      limit: 25,
    }),
    // filterKey captures every filter value
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await api.threads(board.id, query(), signal);
        setThreads(res.threads);
        setNext(res.next_page_cursor);
        live.ensure(res.as_of);
      } catch (e) {
        if (!signal?.aborted) setError(e);
      }
    },
    [board.id, query, live],
  );

  useEffect(() => {
    const ctl = new AbortController();
    setThreads(null);
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const onChange = useCallback(
    (c: Change) => setThreads((list) => (list ? applyThreadChange(list, c, (t) => matchesFilters(t, filters), meId) : list)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, meId],
  );
  const onResync = useCallback(() => void load(), [load]);
  useBoardChanges(onChange, onResync);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const res = await api.threads(board.id, query(next));
      setThreads((list) => {
        const seen = new Set((list ?? []).map((t) => t.id));
        return [...(list ?? []), ...res.threads.filter((t) => !seen.has(t.id))];
      });
      setNext(res.next_page_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const setFilters = (f: Partial<Filters>) => navigate(filtersHref(board.id, { ...filters, ...f }), { replace: true });

  return (
    <div className="with-aside">
      <div className="main-col">
        <div className="toolbar">
          <h1 className="visually-hidden">{board.name}: threads</h1>
          <Segmented
            label="Show"
            value={filters.filter}
            options={[
              ["all", "All"],
              ["following", "Following"],
              ["unread", "Unread"],
            ]}
            onChange={(v) => setFilters({ filter: v })}
          />
          <Segmented
            label="Kind"
            value={filters.kind}
            options={[
              ["all", "Everything"],
              ["discussion", "Discussions"],
              ["task", "Tasks"],
            ]}
            onChange={(v) => setFilters({ kind: v })}
          />
          {canWrite && (
            <button
              type="button"
              className="button button-primary toolbar-end"
              aria-expanded={composing}
              aria-controls="new-thread"
              onClick={() => setComposing((c) => !c)}
            >
              {composing ? "Close composer" : "New thread"}
            </button>
          )}
        </div>
        <LabelFilter labels={filters.labels} onChange={(labels) => setFilters({ labels })} />

        {composing && (
          <NewThreadForm
            boardId={board.id}
            members={members}
            onCancel={() => setComposing(false)}
            onPosted={(t) => navigate(`/b/${board.id}/t/${t.id}`)}
          />
        )}

        <ErrorNote error={error} />
        {threads === null && !error ? (
          <Loading label="Loading threads…" />
        ) : threads && threads.length === 0 ? (
          <Empty title={filters.filter === "unread" ? "You're all caught up" : "No threads here yet"}>
            {filters.filter !== "all" || filters.kind !== "all" || Object.keys(filters.labels).length ? (
              <button type="button" className="link-button" onClick={() => navigate(`/b/${board.id}`, { replace: true })}>
                Clear filters
              </button>
            ) : canWrite ? (
              <p>Start the first thread, or connect an agent from the panel on this page.</p>
            ) : (
              <p>Threads will appear here as members post.</p>
            )}
          </Empty>
        ) : (
          <ul className="thread-list" aria-label="Threads">
            {threads?.map((t) => <ThreadRow key={t.id} t={t} boardId={board.id} />)}
          </ul>
        )}
        {next && (
          <div className="center">
            <button type="button" className="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more threads"}
            </button>
          </div>
        )}
      </div>
      <aside className="aside-col">
        <ConnectPanel />
      </aside>
    </div>
  );
}

function ThreadRow({ t, boardId }: { t: Thread; boardId: string }) {
  const unread = t.unread_count > 0;
  return (
    <li className={`thread-row ${unread ? "unread" : ""}`}>
      <div className="thread-row-main">
        <div className="thread-row-title">
          {t.task && <TaskBadge state={t.task.state} />}
          <Link to={`/b/${boardId}/t/${t.id}`} className="thread-link">
            {t.title}
          </Link>
          {unread && (
            <span className="pill" aria-label={`${t.unread_count} unread`}>
              {t.unread_count} new
            </span>
          )}
        </div>
        <div className="thread-row-meta">
          <Author p={t.created_by} />
          <span>{plural(t.message_count, "message")}</span>
          <TimeAgo iso={t.last_activity_at} prefix="active" />
          {t.task?.assignee && (
            <span>
              assigned to <Author p={t.task.assignee} showKind={false} />
            </span>
          )}
          {t.following && <span className="following-mark">Following</span>}
          {t.links.map((l) => (
            <span key={l.id} className={`platform-tag platform-${l.platform}`}>
              <PlatformName platform={l.platform} />
            </span>
          ))}
        </div>
        <LabelChips labels={t.labels} />
      </div>
    </li>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function LabelFilter({ labels, onChange }: { labels: Labels; onChange: (l: Labels) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseLabels(text);
    if (parsed.error) return setError(parsed.error);
    setError(null);
    setText("");
    onChange({ ...labels, ...parsed.labels });
  }
  const remove = (k: string) => {
    const nextLabels = { ...labels };
    delete nextLabels[k];
    onChange(nextLabels);
  };
  return (
    <form className="label-filter" onSubmit={submit} role="search" aria-label="Filter by label">
      <label htmlFor={id} className="label-filter-label">
        Label
      </label>
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="state=review"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
      />
      <button type="submit" className="button button-small">
        Filter
      </button>
      <LabelChips labels={labels} onRemove={remove} />
      {error && (
        <p id={`${id}-err`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function NewThreadForm({
  boardId,
  members,
  onPosted,
  onCancel,
}: {
  boardId: string;
  members: ReturnType<typeof useBoard>["members"];
  onPosted: (t: Thread) => void;
  onCancel: () => void;
}) {
  const ids = { title: useId(), body: useId(), labels: useId(), task: useId() };
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labelText, setLabelText] = useState("");
  const [task, setTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idem = useIdempotencyKey();
  const toast = useToast();
  const { refreshMe } = useSession();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const parsed = parseLabels(labelText);
    if (parsed.error) return setError(new Error(parsed.error));
    if (!title.trim() || !body.trim()) return setError(new Error("Add a title and a message."));
    const payload = {
      title: title.trim(),
      body,
      mentions: extractMentions(body, members),
      labels: Object.keys(parsed.labels).length ? parsed.labels : undefined,
      task: task || undefined,
    };
    setBusy(true);
    setError(null);
    try {
      const res = await api.startThread(boardId, { ...payload, idempotency_key: idem.keyFor(payload) });
      idem.reset();
      if (res.usage_warning?.length) {
        const w = res.usage_warning[0]!;
        toast(`Heads up: ${w.allowance.replace(/_/g, " ")} at ${Math.round((w.used / w.limit) * 100)}% of the limit.`, "warning");
      }
      onPosted(res.thread);
    } catch (err) {
      setError(err);
      if (isApiError(err, "network")) toast(`${errorText(err)} Your draft is kept; try again.`, "error");
      if (isApiError(err, "quota_exceeded")) void refreshMe();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="new-thread" className="card composer" onSubmit={submit} aria-label="New thread">
      <div className="field">
        <label htmlFor={ids.title}>Title</label>
        <input
          id={ids.title}
          value={title}
          maxLength={MAX_TITLE}
          required
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's this about?"
        />
        <div className="hint counter">
          {title.length}/{MAX_TITLE}
        </div>
      </div>
      <MarkdownEditor
        id={ids.body}
        label="Message"
        value={body}
        onChange={setBody}
        members={members}
        rows={6}
        required
        onSubmitShortcut={() => void submit()}
      />
      <div className="grid-2">
        <div className="field">
          <label htmlFor={ids.labels}>Labels (optional)</label>
          <input
            id={ids.labels}
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder="state=review, area=ios"
          />
          <div className="hint">Comma-separated key=value pairs.</div>
        </div>
        <div className="field checkbox-field">
          <label className="checkbox">
            <input id={ids.task} type="checkbox" checked={task} onChange={(e) => setTask(e.target.checked)} />
            <span>
              This is a task
              <span className="hint block">People and agents can claim it and mark it done.</span>
            </span>
          </label>
        </div>
      </div>
      {labelText && !parseLabels(labelText).error && <LabelChips labels={parseLabels(labelText).labels} />}
      <ErrorNote error={error} />
      <div className="actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Posting…" : error ? "Retry" : task ? "Post task" : "Post thread"}
        </button>
      </div>
    </form>
  );
}

export function ConnectPanel() {
  const origin = window.location.origin;
  return (
    <section className="card connect" aria-labelledby="connect-title">
      <h2 id="connect-title">Connect an agent</h2>
      <p className="muted small">
        MCP clients sign in and choose to act as you or as one of your agents. Their posts show as “agent via you”.
      </p>
      <CopyField label="MCP endpoint" value={`${origin}/mcp`} />
      <CopyField label="Command line" value={`npx openmessageboard login --server ${origin}`} />
      <p className="small">
        <Link to="/agents">Manage agents and tokens</Link>
      </p>
    </section>
  );
}

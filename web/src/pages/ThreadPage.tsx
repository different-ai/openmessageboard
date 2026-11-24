import type { Change, Integration, Message, Thread } from "@openmessageboard/protocol";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api, isApiError } from "../api";
import { useBoard, useBoardChanges } from "../board";
import { MarkdownEditor, extractMentions, useIdempotencyKey } from "../composer";
import { formatDateTime, labelError, newIdempotencyKey, MAX_LABELS } from "../format";
import { excerpt, Markdown } from "../markdown";
import { Link, useTitle } from "../router";
import { AccessRequired } from "./Status";
import {
  Author,
  Avatar,
  ConfirmDialog,
  ErrorNote,
  LabelChips,
  Loading,
  PlatformName,
  TaskBadge,
  TimeAgo,
  errorText,
  useToast,
} from "../ui";

function upsertMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) return [...list, m];
  const copy = list.slice();
  copy[i] = m;
  return copy;
}

export function ThreadPage({ threadId }: { threadId: string }) {
  const { board, live, members, meId, isOwner, canWrite } = useBoard();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [denied, setDenied] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextRef = useRef<string | null>(null);
  nextRef.current = next;
  useTitle(thread?.title ?? "Thread");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api.thread(threadId, undefined, signal);
        if (res.thread.board_id !== board.id) {
          setDenied(true);
          return;
        }
        setThread(res.thread);
        setMessages(res.messages);
        setNext(res.next_page_cursor);
        setError(null);
        live.ensure(res.as_of);
      } catch (e) {
        if (signal?.aborted) return;
        if (isApiError(e, "not_found", "forbidden")) setDenied(true);
        else setError(e);
      }
    },
    [threadId, board.id, live],
  );

  useEffect(() => {
    const ctl = new AbortController();
    setThread(null);
    setMessages([]);
    setDenied(false);
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const onChange = useCallback(
    (c: Change) => {
      if (c.thread_id !== threadId) return;
      if (c.thread) setThread({ ...c.thread, unread_count: 0 });
      if (c.message) {
        const m = c.message;
        // While older pages are still unloaded, new messages arrive with the last page.
        if (c.type === "message.created" && nextRef.current) return;
        setMessages((list) => upsertMessage(list, m));
      } else if (c.type === "message.deleted" && c.message_id) {
        setMessages((list) => list.map((x) => (x.id === c.message_id ? { ...x, deleted: true, body: null } : x)));
      }
    },
    [threadId],
  );
  const onResync = useCallback(() => void load(), [load]);
  useBoardChanges(onChange, onResync);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const res = await api.thread(threadId, next);
      setMessages((list) => res.messages.reduce(upsertMessage, list));
      setThread(res.thread);
      setNext(res.next_page_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  if (denied) return <AccessRequired />;
  if (error && !thread)
    return (
      <div className="page narrow">
        <ErrorNote error={error} />
      </div>
    );
  if (!thread) return <Loading label="Loading thread…" />;

  return (
    <div className="with-aside thread-page">
      <div className="main-col">
        <p className="back">
          <Link to={`/b/${board.id}`}>← All threads</Link>
        </p>
        <header className="thread-head">
          <h1>{thread.title}</h1>
          <div className="thread-head-meta">
            {thread.task ? <TaskBadge state={thread.task.state} /> : <span className="badge">Discussion</span>}
            <Link to={`/b/${board.id}?channel=${encodeURIComponent(thread.channel)}`} className="channel-tag">
              #{thread.channel}
            </Link>
            <span>
              Started by <Author p={thread.created_by} /> <TimeAgo iso={thread.created_at} />
            </span>
            <FollowButton thread={thread} onChange={(following) => setThread((t) => (t ? { ...t, following } : t))} />
          </div>
          <LabelChips labels={thread.labels} />
        </header>

        <ol className="messages" aria-label="Messages">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              m={m}
              parent={m.reply_to ? (byId.get(m.reply_to) ?? null) : null}
              canDelete={!m.deleted && (m.author.id === meId || isOwner)}
              canReply={canWrite && !m.deleted}
              onReply={() => {
                setReplyTo(m);
                document.getElementById("reply-body")?.focus();
              }}
              onDeleted={(deleted) => setMessages((list) => upsertMessage(list, deleted))}
            />
          ))}
        </ol>
        {next && (
          <div className="center">
            <button type="button" className="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load newer messages"}
            </button>
          </div>
        )}
        <ErrorNote error={error} />

        {canWrite ? (
          <ReplyForm
            thread={thread}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            onPosted={(m) => {
              setReplyTo(null);
              if (!nextRef.current) setMessages((list) => upsertMessage(list, m));
              setThread((t) => (t ? { ...t, following: true, message_count: t.message_count + 1 } : t));
            }}
            members={members}
          />
        ) : (
          <p className="note">You're a reader on this board, so you can follow this thread but not reply.</p>
        )}
      </div>
      <aside className="aside-col">
        {thread.task && (
          <TaskPanel
            thread={thread}
            onThread={setThread}
            onMessage={(m) => setMessages((list) => upsertMessage(list, m))}
          />
        )}
        <LabelsEditor thread={thread} onThread={setThread} />
        <LinksPanel thread={thread} onThread={setThread} />
      </aside>
    </div>
  );
}

function FollowButton({ thread, onChange }: { thread: Thread; onChange: (following: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className="button button-small"
      aria-pressed={thread.following}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api.follow(thread.id, !thread.following);
          onChange(res.following);
          toast(res.following ? "Following. Replies reach your inbox." : "Unfollowed.", "success");
        } catch (e) {
          toast(errorText(e), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {thread.following ? "Following" : "Follow"}
    </button>
  );
}

function MessageAuthor({ m }: { m: Message }) {
  if (m.source) {
    return (
      <span className="author">
        <span className="author-name">{m.source.author_name}</span>
        <span className="author-via">
          {" · "}
          {m.source.url ? (
            <a href={m.source.url} target="_blank" rel="noopener nofollow ugc">
              <PlatformName platform={m.source.platform} />
            </a>
          ) : (
            <PlatformName platform={m.source.platform} />
          )}
        </span>
      </span>
    );
  }
  return <Author p={m.author} />;
}

function MessageItem({
  m,
  parent,
  canDelete,
  canReply,
  onReply,
  onDeleted,
}: {
  m: Message;
  parent: Message | null;
  canDelete: boolean;
  canReply: boolean;
  onReply: () => void;
  onDeleted: (m: Message) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = m.source ? m.source.author_name : m.author.display_name;
  return (
    <li id={`m-${m.id}`} className={`message ${m.deleted ? "deleted" : ""} ${m.source ? `synced synced-${m.source.platform}` : ""}`}>
      <Avatar name={name} kind={m.author.kind} />
      <div className="message-body">
        <div className="message-head">
          <MessageAuthor m={m} />
          <a href={`#m-${m.id}`} className="message-time">
            <TimeAgo iso={m.created_at} />
          </a>
        </div>
        {m.reply_to && (
          <a href={`#m-${m.reply_to}`} className="quote">
            {parent ? (
              <>
                <span className="quote-author">Replying to {parent.source ? parent.source.author_name : parent.author.display_name}</span>
                <span className="quote-text">{parent.deleted ? "Deleted message" : excerpt(parent.body, 120)}</span>
              </>
            ) : (
              <span className="quote-author">Replying to an earlier message</span>
            )}
          </a>
        )}
        {m.deleted ? (
          <p className="tombstone">This message was deleted.</p>
        ) : (
          <Markdown source={m.body ?? ""} />
        )}
        {!m.deleted && (canReply || canDelete) && (
          <div className="message-actions">
            {canReply && (
              <button type="button" className="link-button" onClick={onReply}>
                Reply
              </button>
            )}
            {canDelete && (
              <button type="button" className="link-button danger" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this message?"
        body={<p>The text is removed for everyone. A “deleted” marker stays in the thread. This can't be undone.</p>}
        confirmLabel="Delete message"
        onConfirm={async () => {
          const res = await api.deleteMessage(m.id);
          onDeleted(res.message);
        }}
      />
    </li>
  );
}

function ReplyForm({
  thread,
  replyTo,
  onClearReply,
  onPosted,
  members,
}: {
  thread: Thread;
  replyTo: Message | null;
  onClearReply: () => void;
  onPosted: (m: Message) => void;
  members: ReturnType<typeof useBoard>["members"];
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const idem = useIdempotencyKey();
  const toast = useToast();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !body.trim()) return;
    const payload = { body, reply_to: replyTo?.id, mentions: extractMentions(body, members) };
    setBusy(true);
    setError(null);
    try {
      const res = await api.reply(thread.id, { ...payload, idempotency_key: idem.keyFor(payload) });
      idem.reset();
      setBody("");
      onPosted(res.message);
      if (res.usage_warning?.length) {
        const w = res.usage_warning[0]!;
        toast(`Heads up: ${w.allowance.replace(/_/g, " ")} at ${Math.round((w.used / w.limit) * 100)}% of the limit.`, "warning");
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card composer reply" onSubmit={submit} aria-label="Reply">
      {replyTo && (
        <div className="replying-to">
          <span>
            Replying to <strong>{replyTo.source ? replyTo.source.author_name : replyTo.author.display_name}</strong>:{" "}
            <span className="muted">{excerpt(replyTo.body, 80)}</span>
          </span>
          <button type="button" className="icon-button" aria-label="Cancel reply-to" onClick={onClearReply}>
            ×
          </button>
        </div>
      )}
      <MarkdownEditor
        id="reply-body"
        label="Reply"
        value={body}
        onChange={setBody}
        members={members}
        rows={4}
        onSubmitShortcut={() => void submit()}
      />
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy || !body.trim()}>
          {busy ? "Sending…" : error ? "Retry" : "Reply"}
        </button>
      </div>
    </form>
  );
}

function TaskPanel({
  thread,
  onThread,
  onMessage,
}: {
  thread: Thread;
  onThread: (t: Thread) => void;
  onMessage: (m: Message) => void;
}) {
  const { board, meId, isOwner, canWrite } = useBoard();
  const task = thread.task!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState("");
  const resultId = useId();
  const toast = useToast();
  const isAssignee = task.assignee?.id === meId;
  const isCreator = thread.created_by.id === meId;
  const canFinish = isAssignee || isOwner;
  const canCancel = isCreator || isOwner;

  async function run(label: string, fn: () => Promise<{ thread: Thread; message?: Message | null }>, done: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      onThread(res.thread);
      if (res.message) onMessage(res.message);
      toast(done, "success");
      setCompleting(false);
      setResult("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const update = (action: "complete" | "release" | "cancel" | "reopen", extra?: string) =>
    api.updateTask(thread.id, { action, result: extra || undefined, idempotency_key: newIdempotencyKey() });

  return (
    <section className="card panel" aria-labelledby="task-title">
      <h2 id="task-title">Task</h2>
      <dl className="facts">
        <div>
          <dt>State</dt>
          <dd>
            <TaskBadge state={task.state} />
          </dd>
        </div>
        <div>
          <dt>Assignee</dt>
          <dd>{task.assignee ? <Author p={task.assignee} /> : <span className="muted">Nobody yet</span>}</dd>
        </div>
        {task.claimed_at && (
          <div>
            <dt>Claimed</dt>
            <dd title={formatDateTime(task.claimed_at)}>
              <TimeAgo iso={task.claimed_at} />
            </dd>
          </div>
        )}
        {task.completed_at && (
          <div>
            <dt>{task.state === "cancelled" ? "Closed" : "Completed"}</dt>
            <dd>
              <TimeAgo iso={task.completed_at} />
            </dd>
          </div>
        )}
      </dl>
      {canWrite && (
        <div className="task-actions">
          {task.state === "open" && (
            <button
              type="button"
              className="button button-primary"
              disabled={!!busy}
              onClick={() => run("claim", () => api.claimTask(board.id, { thread_id: thread.id }), "You claimed this task.")}
            >
              {busy === "claim" ? "Claiming…" : "Claim"}
            </button>
          )}
          {task.state === "claimed" && canFinish && !completing && (
            <button type="button" className="button button-primary" disabled={!!busy} onClick={() => setCompleting(true)}>
              Complete…
            </button>
          )}
          {task.state === "claimed" && canFinish && (
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => run("release", () => update("release"), "Task released. It's open again.")}
            >
              {busy === "release" ? "Releasing…" : "Release"}
            </button>
          )}
          {(task.state === "open" || task.state === "claimed") && canCancel && (
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => run("cancel", () => update("cancel"), "Task cancelled.")}
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel task"}
            </button>
          )}
          {(task.state === "done" || task.state === "cancelled") && canCancel && (
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => run("reopen", () => update("reopen"), "Task reopened.")}
            >
              {busy === "reopen" ? "Reopening…" : "Reopen"}
            </button>
          )}
        </div>
      )}
      {completing && (
        <form
          className="stack complete-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("complete", () => update("complete", result.trim()), "Task marked done.");
          }}
        >
          <div className="field">
            <label htmlFor={resultId}>Result (optional)</label>
            <textarea
              id={resultId}
              rows={4}
              value={result}
              onChange={(e) => setResult(e.target.value)}
              placeholder="What was done? Posted as a reply. Markdown supported."
            />
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={() => setCompleting(false)}>
              Back
            </button>
            <button type="submit" className="button button-primary" disabled={!!busy}>
              {busy === "complete" ? "Completing…" : "Mark done"}
            </button>
          </div>
        </form>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function LabelsEditor({ thread, onThread }: { thread: Thread; onThread: (t: Thread) => void }) {
  const { canWrite } = useBoard();
  const keyId = useId();
  const valueId = useId();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const count = Object.keys(thread.labels).length;

  async function apply(body: { set?: Record<string, string>; remove?: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setLabels(thread.id, body);
      onThread(res.thread);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const k = key.trim().toLowerCase();
    const v = value.trim();
    const err = labelError(k, v);
    if (err) return setError(new Error(err));
    if (!(k in thread.labels) && count >= MAX_LABELS) return setError(new Error(`At most ${MAX_LABELS} labels.`));
    if (await apply({ set: { [k]: v } })) {
      setKey("");
      setValue("");
    }
  }

  return (
    <section className="card panel" aria-labelledby="labels-title">
      <h2 id="labels-title">Labels</h2>
      {count === 0 && <p className="muted small">No labels.</p>}
      <LabelChips labels={thread.labels} onRemove={canWrite ? (k) => void apply({ remove: [k] }) : undefined} disabled={busy} />
      {canWrite && (
        <form className="label-add" onSubmit={add}>
          <div className="field">
            <label htmlFor={keyId}>Key</label>
            <input id={keyId} value={key} onChange={(e) => setKey(e.target.value)} placeholder="state" autoCapitalize="none" />
          </div>
          <div className="field">
            <label htmlFor={valueId}>Value</label>
            <input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} placeholder="review" />
          </div>
          <button type="submit" className="button button-small" disabled={busy || !key || !value}>
            Set
          </button>
        </form>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function LinksPanel({ thread, onThread }: { thread: Thread; onThread: (t: Thread) => void }) {
  const { board, isOwner } = useBoard();
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [integrationId, setIntegrationId] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const selectId = useId();
  const refId = useId();
  const toast = useToast();

  useEffect(() => {
    if (!isOwner) return;
    api
      .integrations(board.id)
      .then((r) => {
        setIntegrations(r.integrations);
        if (r.integrations[0]) setIntegrationId(r.integrations[0].id);
      })
      .catch(() => setIntegrations([]));
  }, [isOwner, board.id]);

  if (!thread.links.length && !isOwner) return null;

  async function link(e: FormEvent) {
    e.preventDefault();
    if (!integrationId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.linkThread(thread.id, { integration_id: integrationId, external_ref: ref.trim() || undefined });
      onThread({ ...thread, links: [...thread.links.filter((l) => l.id !== res.link.id), res.link] });
      setRef("");
      toast("Thread linked.", "success");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const selected = integrations?.find((i) => i.id === integrationId);
  const refHint =
    selected?.platform === "slack"
      ? "Slack: channel/ts of an existing thread."
      : selected?.platform === "github"
        ? "GitHub: owner/repo#number."
        : selected?.platform === "linear"
          ? "Linear: an issue identifier such as ENG-123."
          : "";

  return (
    <section className="card panel" aria-labelledby="links-title">
      <h2 id="links-title">Linked elsewhere</h2>
      {thread.links.length === 0 ? (
        <p className="muted small">Not linked to Slack, GitHub or Linear.</p>
      ) : (
        <ul className="link-list">
          {thread.links.map((l) => (
            <li key={l.id}>
              <span className={`platform-tag platform-${l.platform}`}>
                <PlatformName platform={l.platform} />
              </span>{" "}
              {l.url ? (
                <a href={l.url} target="_blank" rel="noopener nofollow ugc" className="mono">
                  {l.external_ref}
                </a>
              ) : (
                <span className="mono">{l.external_ref}</span>
              )}
              {isOwner && (
                <button
                  type="button"
                  className="link-button danger"
                  disabled={unlinking === l.id}
                  onClick={async () => {
                    setUnlinking(l.id);
                    try {
                      await api.unlinkThread(l.id);
                      onThread({ ...thread, links: thread.links.filter((x) => x.id !== l.id) });
                    } catch (err) {
                      setError(err);
                    } finally {
                      setUnlinking(null);
                    }
                  }}
                >
                  Unlink
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner &&
        (integrations === null ? null : integrations.length === 0 ? (
          <p className="small">
            <Link to={`/b/${board.id}/integrations`}>Add an integration</Link> to link threads.
          </p>
        ) : (
          <form className="stack link-form" onSubmit={link}>
            <div className="field">
              <label htmlFor={selectId}>Integration</label>
              <select id={selectId} value={integrationId} onChange={(e) => setIntegrationId(e.target.value)}>
                {integrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.platform})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={refId}>Existing thread or issue (optional)</label>
              <input id={refId} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Leave empty to create a new one" />
              <div className="hint">{refHint}</div>
            </div>
            <button type="submit" className="button button-small" disabled={busy}>
              {busy ? "Linking…" : ref.trim() ? "Link" : "Create and link"}
            </button>
          </form>
        ))}
      <ErrorNote error={error} />
    </section>
  );
}

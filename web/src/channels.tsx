import type { Change, Channel } from "@openmessageboard/protocol";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, isApiError } from "./api";
import { useBoard, useBoardChanges } from "./board";
import { Link, navigate } from "./router";
import { useSession } from "./session";
import { Dialog, ErrorNote, useToast } from "./ui";
import { SubscriptionsDialog, effectiveLevel, levelBadge, useSubscriptions } from "./subscriptions";

export const DEFAULT_CHANNEL = "general";
const CHANNEL_RE = /^[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,40}){0,5}$/;

export function channelError(path: string, allowSubtree = false): string | null {
  const p = allowSubtree && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!p) return "Name the channel.";
  if (p.length > 120 || !CHANNEL_RE.test(p)) return "Use lowercase letters, digits, - and _, with / between levels (for example www/production).";
  return null;
}

/** Whether a thread's channel matches a filter: an exact channel, or a path ending in / for its subtree. */
export function inChannel(filter: string | undefined, channel: string): boolean {
  if (!filter) return true;
  if (!filter.endsWith("/")) return channel === filter;
  return channel === filter.slice(0, -1) || channel.startsWith(filter);
}

/** The board's channels the viewer can read, kept fresh as threads appear in new channels. */
export function useChannels(): { channels: Channel[] | null; error: unknown; reload: () => void } {
  const { board } = useBoard();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const ctl = new AbortController();
    api
      .channels(board.id, ctl.signal)
      .then((r) => {
        setChannels(r.channels);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e);
      });
    return () => ctl.abort();
  }, [board.id, version]);
  const onChange = useCallback(
    (c: Change) => {
      if (c.type === "board.updated" || (c.type === "thread.created" && c.thread)) reload();
    },
    [reload],
  );
  useBoardChanges(onChange, reload);
  return { channels, error, reload };
}

function channelHref(boardId: string, search: string, channel: string | null): string {
  const p = new URLSearchParams(search);
  if (channel) p.set("channel", channel);
  else p.delete("channel");
  const s = p.toString();
  return `/b/${boardId}${s ? `?${s}` : ""}`;
}

/** Channel list with thread counts; choosing one filters the thread list. */
export function ChannelsPanel({ current, search }: { current: string | undefined; search: string }) {
  const { board, canWrite, isMember } = useBoard();
  const { channels, error, reload } = useChannels();
  // Subscriptions are a member's: someone reading through a public grant has no inbox for this board.
  const subscriptions = useSubscriptions(board.id, isMember);
  const [creating, setCreating] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const total = channels?.reduce((n, c) => n + c.thread_count, 0) ?? 0;
  const subs = subscriptions.subs ?? [];
  return (
    <section className="card channels-panel" aria-labelledby="channels-title">
      <div className="card-head">
        <h2 id="channels-title">Channels</h2>
        {canWrite && (
          <button type="button" className="button button-small" onClick={() => setCreating(true)}>
            New channel
          </button>
        )}
      </div>
      <ErrorNote error={error} />
      <ul className="channel-list" aria-label="Channels">
        <li>
          <Link to={channelHref(board.id, search, null)} className="channel-link" aria-current={!current ? "page" : undefined}>
            <span className="channel-name">All channels</span>
            <span className="channel-count">
              {total}
              <span className="visually-hidden"> {total === 1 ? "thread" : "threads"}</span>
            </span>
          </Link>
        </li>
        {channels?.map((c) => (
          <li key={c.path}>
            <Link to={channelHref(board.id, search, c.path)} className="channel-link" aria-current={current === c.path ? "page" : undefined}>
              <span className="channel-name">
                <span aria-hidden="true">#</span>
                {c.path}
              </span>
              {c.private && <span className="badge channel-private">private</span>}
              {c.public && (
                <span className="badge channel-private badge-public" title="People who are not members can read this channel.">
                  public
                </span>
              )}
              {levelBadge(effectiveLevel(subs, c.path)) && (
                <span className="badge channel-private badge-plain" title="What this channel sends to your inbox. Change it under Inbox subscriptions.">
                  {levelBadge(effectiveLevel(subs, c.path))}
                </span>
              )}
              <span className="channel-count">
                {c.thread_count}
                <span className="visually-hidden"> {c.thread_count === 1 ? "thread" : "threads"}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {current?.endsWith("/") && <p className="hint">Showing {current} and every channel under it.</p>}
      {!isMember && <p className="hint">These are the board's public channels. Its other channels are for its members.</p>}
      {isMember && (
        <p className="channels-foot">
          <button type="button" className="link-button" onClick={() => setSubscribing(true)}>
            Inbox subscriptions
          </button>
          <span className="hint">What each channel sends to your inbox.</span>
        </p>
      )}
      {isMember && (
        <SubscriptionsDialog open={subscribing} onClose={() => setSubscribing(false)} boardName={board.name} channels={channels ?? []} subscriptions={subscriptions} />
      )}
      <CreateChannelDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false);
          reload();
          navigate(channelHref(board.id, search, c.path), { replace: true });
        }}
      />
    </section>
  );
}

function CreateChannelDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Channel) => void }) {
  const { board, isOwner } = useBoard();
  const ids = { path: useId(), priv: useId() };
  const [path, setPath] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = channelError(path.trim());
    if (problem) return setError(new Error(problem));
    setBusy(true);
    setError(null);
    try {
      const res = await api.createChannel(board.id, { path: path.trim(), ...(priv ? { private: true } : {}) });
      toast(res.created ? `Created #${res.channel.path}${res.channel.private ? " (private)" : ""}` : `#${res.channel.path} already exists`, "success");
      setPath("");
      setPriv(false);
      onCreated(res.channel);
    } catch (err) {
      setError(isApiError(err, "conflict") && err.details.reason === "channel_exists" ? new Error("That channel, or one under it, already exists. Use the Access page to close it.") : err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New channel">
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={ids.path}>Channel</label>
          <input id={ids.path} value={path} onChange={(e) => setPath(e.target.value.toLowerCase())} placeholder="www/production" autoFocus maxLength={120} />
          <div className="hint">Lowercase letters, digits, - and _. Use / for levels. A first post also creates a channel.</div>
        </div>
        <label className="checkbox">
          <input id={ids.priv} type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span>
            Private
            <span className="hint block">
              Only you can read and post until you add people on the Access page.{isOwner ? "" : " Needs manage permission there."}
            </span>
          </span>
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Board switcher in the board header, with "Create board" for people. */
export function BoardSwitcher() {
  const { board } = useBoard();
  const { me, principal, refreshMe } = useSession();
  const [open, setOpen] = useState(false);
  const id = useId();
  const boards = me?.memberships ?? [];
  // A public board read without membership is not among the caller's boards: list it too, so the switcher shows where they are.
  const listed = boards.some((b) => b.board_id === board.id);
  const owned = me?.owned_boards?.length ?? 0;
  const limit = me?.principal.limits?.boards_owned;
  const atLimit = typeof limit === "number" && owned >= limit;
  return (
    <div className="board-switcher">
      {boards.length > (listed ? 1 : 0) && (
        <>
          <label htmlFor={id} className="visually-hidden">
            Switch board
          </label>
          <select id={id} value={board.id} onChange={(e) => navigate(`/b/${e.target.value}`)}>
            {!listed && <option value={board.id}>{board.name} (public)</option>}
            {boards.map((b) => (
              <option key={b.board_id} value={b.board_id}>
                {b.board_name}
                {b.is_owner ? "" : ` (${b.role})`}
              </option>
            ))}
          </select>
        </>
      )}
      {principal?.kind === "human" && (
        <button type="button" className="button button-small" onClick={() => setOpen(true)} disabled={atLimit} title={atLimit ? `Your plan allows ${limit} board${limit === 1 ? "" : "s"}` : undefined}>
          Create board
        </button>
      )}
      <CreateBoardDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={async (id) => {
          setOpen(false);
          await refreshMe();
          navigate(`/b/${id}`);
        }}
      />
    </div>
  );
}

function CreateBoardDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(new Error("Name the board."));
    setBusy(true);
    setError(null);
    try {
      const board = await api.createBoard(name.trim());
      setName("");
      onCreated(board.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Create board">
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={id}>Board name</label>
          <input id={id} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Security" />
          <div className="hint">A separate board with its own members, channels and grants. Names are unique among your boards.</div>
        </div>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Creating…" : "Create board"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

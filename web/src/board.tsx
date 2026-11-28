import type { Board, Change, Member } from "@openmessageboard/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, isApiError } from "./api";
import { formatZoned } from "./format";
import { BoardLive, POLL_SECONDS, type LiveStatus } from "./live";
import { Link, navigate, signInHref, type BoardSection } from "./router";
import { useSession } from "./session";
import { ShareDialog } from "./share";
import { ErrorNote, Loading, errorText, useToast } from "./ui";
import { AccessEnded, AccessRequired } from "./pages/Status";
import { BoardSwitcher } from "./channels";
import { useDoorway } from "./doorway";

type BoardValue = {
  board: Board;
  members: Member[];
  meId: string;
  isOwner: boolean;
  /** False for someone reading through a public grant: they read, and every members' page and write is refused. */
  isMember: boolean;
  canWrite: boolean;
  live: BoardLive;
  setBoard: (b: Board) => void;
  reloadMembers: () => Promise<void>;
  setMembers: (fn: (m: Member[]) => Member[]) => void;
};

const BoardContext = createContext<BoardValue | null>(null);

export function useBoard(): BoardValue {
  const v = useContext(BoardContext);
  if (!v) throw new Error("useBoard outside BoardShell");
  return v;
}

/** Subscribe to this board's live changes for as long as the component is mounted. */
export function useBoardChanges(fn: (c: Change) => void, onResync?: () => void) {
  const { live } = useBoard();
  useEffect(() => live.changes.on(fn), [live, fn]);
  useEffect(() => (onResync ? live.resync.on(onResync) : undefined), [live, onResync]);
}

type State = "loading" | "ready" | "denied" | "ended" | "error";

export function BoardShell({ boardId, section, children }: { boardId: string; section: BoardSection | "thread"; children: ReactNode }) {
  const { principal } = useSession();
  // On a doorway server the board is read through an agent: only the management pages are here.
  const doorway = useDoorway();
  const [board, setBoard] = useState<Board | null>(null);
  const [members, setMembersState] = useState<Member[]>([]);
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [shareOpen, setShareOpen] = useState(false);
  const live = useMemo(() => new BoardLive(boardId), [boardId]);

  const fail = useCallback((e: unknown) => {
    if (isApiError(e, "unauthenticated")) navigate(signInHref(), { replace: true });
    else if (isApiError(e, "access_ended")) setState("ended");
    else if (isApiError(e, "not_found", "forbidden")) setState("denied");
    else {
      setError(e);
      setState("error");
    }
  }, []);

  const reloadMembers = useCallback(async () => {
    // Who the members are is for members: the server refuses someone reading through a public grant.
    if (live.polling) return;
    try {
      setMembersState((await api.members(boardId)).members);
    } catch (e) {
      if (isApiError(e, "access_ended", "not_found")) fail(e);
    }
  }, [boardId, fail, live]);

  useEffect(() => {
    const ctl = new AbortController();
    setState("loading");
    api
      .board(boardId, ctl.signal)
      .then((b) => {
        // Someone who is not a member gets no live stream: the page polls for changes instead.
        live.polling = b.my_access === "public";
        setBoard(b);
        setState("ready");
        void reloadMembers();
      })
      .catch((e) => {
        if (!ctl.signal.aborted) fail(e);
      });
    return () => ctl.abort();
  }, [boardId, fail, reloadMembers, live]);

  useEffect(() => {
    const offStatus = live.statusChanged.on(setStatus);
    const offEnded = live.ended.on(() => {
      // A membership that ended on a public board leaves what the public reads: load the page again as a reader.
      api
        .board(boardId)
        .then((b) => (b.my_access === "public" ? window.location.reload() : setState("ended")))
        .catch(() => setState("ended"));
    });
    const offLost = live.lost.on(fail);
    const offChange = live.changes.on((c) => {
      if (c.type === "board.updated") {
        api.board(boardId).then(setBoard).catch(fail);
      } else if (c.member && (c.type === "member.joined" || c.type === "member.updated")) {
        const m = c.member;
        setMembersState((all) => [...all.filter((x) => x.principal.id !== m.principal.id), m]);
        if (m.principal.id === principal?.id) api.board(boardId).then(setBoard).catch(fail);
      } else if (c.type === "member.left") {
        const id = c.member?.principal.id;
        if (id) setMembersState((all) => all.filter((x) => x.principal.id !== id));
      }
    });
    const offResync = live.resync.on(() => {
      void reloadMembers();
      api.board(boardId).then(setBoard).catch(fail);
    });
    return () => {
      offStatus();
      offEnded();
      offLost();
      offChange();
      offResync();
      live.close();
    };
  }, [live, boardId, fail, reloadMembers, principal?.id]);

  // Views that read threads open the stream with their own as_of cursor; the rest open it here.
  useEffect(() => {
    if (state === "ready" && section !== "threads" && section !== "tasks" && section !== "thread") live.ensure();
  }, [state, section, live]);

  const setMembers = useCallback((fn: (m: Member[]) => Member[]) => setMembersState(fn), []);

  const value = useMemo<BoardValue | null>(
    () =>
      board && principal
        ? {
            board,
            members,
            meId: principal.id,
            isOwner: board.my_role === "owner",
            // Someone reading through a public grant has no role: they read and nothing else.
            isMember: board.my_role !== null,
            canWrite: board.my_role !== null && board.my_role !== "reader",
            live,
            setBoard,
            reloadMembers,
            setMembers,
          }
        : null,
    [board, members, principal, live, reloadMembers, setMembers],
  );

  if (state === "denied") return <AccessRequired />;
  if (state === "ended") return <AccessEnded />;
  if (state === "error")
    return (
      <div className="page narrow">
        <h1>Couldn't load this board</h1>
        <ErrorNote error={error} />
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!value) return <Loading label="Loading board…" />;

  const b = value.board;
  // Threads and tasks are what a public grant opens; every other page needs membership (`member`) or ownership.
  const tabs: { key: BoardSection; label: string; to: string; member?: boolean; owner?: boolean }[] = [
    { key: "threads", label: "Threads", to: `/b/${b.id}` },
    { key: "tasks", label: "Tasks", to: `/b/${b.id}/tasks` },
    { key: "members", label: "Members", to: `/b/${b.id}/members`, member: true },
    { key: "access", label: "Access", to: `/b/${b.id}/access`, member: true },
    { key: "integrations", label: "Integrations", to: `/b/${b.id}/integrations`, owner: true },
    { key: "workload", label: "Workload identity", to: `/b/${b.id}/workload`, owner: true },
    { key: "watchers", label: "Watchers", to: `/b/${b.id}/watchers`, owner: true },
    { key: "settings", label: "Settings", to: `/b/${b.id}/settings`, owner: true },
  ];
  const current = section === "thread" ? "threads" : section;
  const membersOnly = !value.isMember && current !== "threads" && current !== "tasks";

  return (
    <BoardContext.Provider value={value}>
      <div className="board">
        <div className="board-head">
          <div className="board-title-row">
            <div className="board-title">
              {doorway ? (
                <span className="board-name">{b.name}</span>
              ) : (
                <Link to={`/b/${b.id}`} className="board-name">
                  {b.name}
                </Link>
              )}
              {b.my_role ? <span className={`badge role-${b.my_role}`}>{b.my_role}</span> : <span className="badge badge-plain">Not a member</span>}
              {b.visibility === "public" && (
                <span className="badge badge-public" title="Anyone signed in on this server who has the board's address can read its public channels.">
                  Public
                </span>
              )}
              <LiveDot status={status} />
            </div>
            <div className="board-title-actions">
              {!doorway && <BoardSwitcher />}
              {value.isOwner && (
                <button type="button" className="button button-primary" onClick={() => setShareOpen(true)}>
                  Share
                </button>
              )}
            </div>
          </div>
          {b.my_access_ends_at && (
            <p className="note note-warning compact">Your access to this board ends {formatZoned(b.my_access_ends_at)}.</p>
          )}
          {!value.isMember && <PublicReaderNote board={b} live={live} />}
          <nav className="board-tabs" aria-label="Board">
            {tabs
              .filter((t) => (!t.owner || value.isOwner) && (!t.member || value.isMember) && !(doorway && (t.key === "threads" || t.key === "tasks")))
              .map((t) => (
                <Link key={t.key} to={t.to} className="board-tab" aria-current={current === t.key ? "page" : undefined}>
                  {t.label}
                </Link>
              ))}
          </nav>
        </div>
        <div className="board-body">{membersOnly ? <MembersOnly board={b} doorway={!!doorway} /> : children}</div>
      </div>
      {value.isOwner && <ShareDialog board={b} open={shareOpen} onClose={() => setShareOpen(false)} />}
    </BoardContext.Provider>
  );
}

/**
 * Shown on every page of a board to someone who reads it through a public grant: that they are not a member, what
 * that leaves them, a way to refresh (they get no live stream), and saving the board for their agents.
 */
function PublicReaderNote({ board, live }: { board: Board; live: BoardLive }) {
  const { me, principal, refreshMe } = useSession();
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);
  const toast = useToast();
  const saved = !!me?.saved_boards?.some((b) => b.id === board.id);

  async function setSaved(next: boolean) {
    setBusy("save");
    try {
      if (next) await api.saveBoard(board.id);
      else await api.unsaveBoard(board.id);
      await refreshMe();
      toast(next ? "Saved. Your agents and profiles can now read this board's public channels." : "Removed from your saved boards. Your agents and profiles can no longer read it.", "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      await live.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="note public-reader" aria-label="Reading a public board">
      <div className="public-reader-row">
        <p>
          <strong>You're reading a public board and are not a member.</strong> You can read its public channels. You can't post, reply, react or
          follow threads, and you don't see its members or its other channels. New posts are checked for every {POLL_SECONDS} seconds, not live.
        </p>
        <button type="button" className="button button-small" onClick={() => void refresh()} disabled={busy === "refresh"}>
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {principal?.kind === "human" && (
        <div className="public-reader-row">
          <p>
            {saved ? (
              <>
                <strong>Saved: your agents and profiles can read this board's public channels.</strong> Unsave it and they are told it doesn't
                exist; you can still read it here.
              </>
            ) : (
              <>
                <strong>Save this board to let your agents and profiles read it too.</strong> Until you do, an agent of yours that is given this
                address is told the board doesn't exist. Saving doesn't make you a member.
              </>
            )}
          </p>
          <button type="button" className={`button button-small ${saved ? "" : "button-primary"}`} aria-pressed={saved} onClick={() => void setSaved(!saved)} disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : saved ? "Unsave" : "Save board"}
          </button>
        </div>
      )}
    </section>
  );
}

/** A members' page (members, access, settings and the rest), asked for by someone who is not a member. */
function MembersOnly({ board, doorway }: { board: Board; doorway: boolean }) {
  return (
    <div className="page narrow status-page">
      <h1>This page is for members</h1>
      <p className="lead">
        You're reading {board.name} as a public board. Its members, access rules, integrations and settings are only shown to its members.
      </p>
      <div className="actions start">
        {/* On a doorway server the board is read through an agent: its address opens the server's own page. */}
        {doorway ? (
          <a href={`/b/${board.id}`} className="button button-primary">
            Open the board
          </a>
        ) : (
          <Link to={`/b/${board.id}`} className="button button-primary">
            Read the board
          </Link>
        )}
      </div>
    </div>
  );
}

function LiveDot({ status }: { status: LiveStatus }) {
  const text: Record<LiveStatus, string> = {
    idle: "Not connected",
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    ended: "Disconnected",
    polling: `Checks every ${POLL_SECONDS} s`,
  };
  return (
    <span className={`live-dot live-${status}`} title={text[status]}>
      <span className="live-dot-mark" aria-hidden="true" />
      <span className="live-dot-text">{text[status]}</span>
    </span>
  );
}

import type { Board, Change, Member } from "@openmessageboard/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, isApiError } from "./api";
import { formatZoned } from "./format";
import { BoardLive, type LiveStatus } from "./live";
import { Link, navigate, signInHref, type BoardSection } from "./router";
import { useSession } from "./session";
import { ShareDialog } from "./share";
import { ErrorNote, Loading } from "./ui";
import { AccessEnded, AccessRequired } from "./pages/Status";

type BoardValue = {
  board: Board;
  members: Member[];
  meId: string;
  isOwner: boolean;
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
    try {
      setMembersState((await api.members(boardId)).members);
    } catch (e) {
      if (isApiError(e, "access_ended", "not_found")) fail(e);
    }
  }, [boardId, fail]);

  useEffect(() => {
    const ctl = new AbortController();
    setState("loading");
    api
      .board(boardId, ctl.signal)
      .then((b) => {
        setBoard(b);
        setState("ready");
      })
      .catch((e) => {
        if (!ctl.signal.aborted) fail(e);
      });
    void reloadMembers();
    return () => ctl.abort();
  }, [boardId, fail, reloadMembers]);

  useEffect(() => {
    const offStatus = live.statusChanged.on(setStatus);
    const offEnded = live.ended.on(() => setState("ended"));
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
            canWrite: board.my_role !== "reader",
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
  const tabs: { key: BoardSection; label: string; to: string; owner?: boolean }[] = [
    { key: "threads", label: "Threads", to: `/b/${b.id}` },
    { key: "tasks", label: "Tasks", to: `/b/${b.id}/tasks` },
    { key: "members", label: "Members", to: `/b/${b.id}/members` },
    { key: "integrations", label: "Integrations", to: `/b/${b.id}/integrations`, owner: true },
    { key: "workload", label: "Workload identity", to: `/b/${b.id}/workload`, owner: true },
    { key: "settings", label: "Settings", to: `/b/${b.id}/settings`, owner: true },
  ];
  const current = section === "thread" ? "threads" : section;

  return (
    <BoardContext.Provider value={value}>
      <div className="board">
        <div className="board-head">
          <div className="board-title-row">
            <div className="board-title">
              <Link to={`/b/${b.id}`} className="board-name">
                {b.name}
              </Link>
              <span className={`badge role-${b.my_role}`}>{b.my_role}</span>
              <LiveDot status={status} />
            </div>
            {value.isOwner && (
              <button type="button" className="button button-primary" onClick={() => setShareOpen(true)}>
                Share
              </button>
            )}
          </div>
          {b.my_access_ends_at && (
            <p className="note note-warning compact">Your access to this board ends {formatZoned(b.my_access_ends_at)}.</p>
          )}
          <nav className="board-tabs" aria-label="Board">
            {tabs
              .filter((t) => !t.owner || value.isOwner)
              .map((t) => (
                <Link key={t.key} to={t.to} className="board-tab" aria-current={current === t.key ? "page" : undefined}>
                  {t.label}
                </Link>
              ))}
          </nav>
        </div>
        <div className="board-body">{children}</div>
      </div>
      {value.isOwner && <ShareDialog board={b} open={shareOpen} onClose={() => setShareOpen(false)} />}
    </BoardContext.Provider>
  );
}

function LiveDot({ status }: { status: LiveStatus }) {
  const text: Record<LiveStatus, string> = {
    idle: "Not connected",
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
    ended: "Disconnected",
  };
  return (
    <span className={`live-dot live-${status}`} title={text[status]}>
      <span className="live-dot-mark" aria-hidden="true" />
      <span className="live-dot-text">{text[status]}</span>
    </span>
  );
}

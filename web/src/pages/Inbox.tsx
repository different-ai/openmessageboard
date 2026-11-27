import type { InboxItem, InboxKind } from "@openmessageboard/protocol";
import { useEffect, useState } from "react";
import { api } from "../api";
import { excerpt } from "../markdown";
import { Link, useTitle } from "../router";
import { useInbox, useSession } from "../session";
import { Author, Empty, ErrorNote, Loading, TimeAgo, errorText, useToast } from "../ui";
import { Segmented } from "./BoardThreads";

const KIND_LABEL: Record<InboxKind, string> = {
  mention: "Mention",
  reply: "Reply",
  task_assigned: "Task assigned",
  thread: "New thread",
  message: "New message",
};

export function Inbox() {
  useTitle("Inbox");
  const { me } = useSession();
  const { onItem, setUnread, unread } = useInbox();
  const [show, setShow] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const boardNames = new Map<string, string>();
  if (me?.owned_board) boardNames.set(me.owned_board.id, me.owned_board.name);
  me?.memberships.forEach((m) => boardNames.set(m.board_id, m.board_name));

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    api
      .inbox({ unread_only: show === "unread", limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setAsOf(page.as_of);
        setNext(page.next_page_cursor);
        setUnread(page.unread_count);
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [show, setUnread]);

  useEffect(
    () =>
      onItem((item) =>
        setItems((list) => (list && !list.some((x) => x.id === item.id) ? [item, ...list] : list)),
      ),
    [onItem],
  );

  async function loadMore() {
    if (!next) return;
    try {
      const page = await api.inbox({ unread_only: show === "unread", limit: 50, page_cursor: next });
      setItems((list) => [...(list ?? []), ...page.items.filter((i) => !list?.some((x) => x.id === i.id))]);
      setNext(page.next_page_cursor);
    } catch (e) {
      setError(e);
    }
  }

  async function markRead(ids: string[]) {
    try {
      const res = await api.markRead({ item_ids: ids });
      const now = new Date().toISOString();
      setItems((list) => list?.map((i) => (ids.includes(i.id) ? { ...i, read_at: i.read_at ?? now } : i)) ?? null);
      setUnread(res.unread_count);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function markAll() {
    if (!asOf) return;
    setBusy(true);
    try {
      const res = await api.markRead({ up_to_cursor: asOf });
      const now = new Date().toISOString();
      setItems((list) => list?.map((i) => ({ ...i, read_at: i.read_at ?? now })) ?? null);
      setUnread(res.unread_count);
      toast(res.marked ? `Marked ${res.marked} read.` : "Nothing to mark.", "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1 className="page-title">
          Inbox {unread > 0 && <span className="pill">{unread} unread</span>}
        </h1>
        <Segmented
          label="Show"
          value={show}
          options={[
            ["all", "All"],
            ["unread", "Unread"],
          ]}
          onChange={setShow}
        />
        <button type="button" className="button toolbar-end" onClick={markAll} disabled={busy || !asOf || unread === 0}>
          Mark all read
        </button>
      </div>
      <p className="muted small">Mentions, replies in threads you follow, and tasks assigned to you.</p>
      <ErrorNote error={error} />
      {items === null && !error ? (
        <Loading label="Loading inbox…" />
      ) : items && items.length === 0 ? (
        <Empty title={show === "unread" ? "You're all caught up" : "Nothing here yet"}>
          <p>When someone mentions you or replies in a thread you follow, it shows up here.</p>
        </Empty>
      ) : (
        <ul className="inbox-list">
          {items?.map((item) => (
            <li key={item.id} className={`inbox-item ${item.read_at ? "" : "unread"}`}>
              <div className="inbox-main">
                <div className="inbox-head">
                  <span className={`badge inbox-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <Link to={`/b/${item.board_id}/t/${item.thread_id}${item.message ? `#m-${item.message.id}` : ""}`} className="thread-link">
                    {item.thread_title}
                  </Link>
                  {boardNames.get(item.board_id) && <span className="muted small">in {boardNames.get(item.board_id)}</span>}
                </div>
                {item.message && (
                  <p className="inbox-excerpt">
                    {item.message.source ? <strong>{item.message.source.author_name}</strong> : <Author p={item.message.author} showKind={false} />}
                    {": "}
                    {item.message.deleted ? <em>Deleted message</em> : excerpt(item.message.body, 180)}
                  </p>
                )}
                <TimeAgo iso={item.created_at} />
              </div>
              {!item.read_at && (
                <button type="button" className="button button-small" onClick={() => void markRead([item.id])}>
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <div className="center">
          <button type="button" className="button" onClick={loadMore}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

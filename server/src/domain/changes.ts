import { WAIT_MAX_SECONDS, type Change, type ChangesPage, type InboxChangesPage, type InboxItem, type EventType } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { read } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import type { HubEvent } from "../live/hub.js";
import { activeMembership, getMembership, nowIso, requireMember, requireThread } from "./access.js";
import { boardInScope } from "../auth/scopes.js";
import { decodeCursor, decodePage, encodeCursor, encodePage } from "./cursors.js";
import type { Actor, EventRow, InboxRow, MembershipRow, MessageRow, ThreadRow } from "./model.js";
import { presentInbox, presentMember, presentMessages, presentThreads, principalRefs } from "./present.js";
import { validateLabels } from "./conversation.js";
import { messageLabelFilter } from "./messages.js";

/** Read filters on board changes. `labels` matches a change's message or its thread's root; other changes are left out. */
export interface ChangeFilters {
  labels?: Record<string, string> | undefined;
}

function purgedUpto(ctx: AppContext): number {
  return Number((ctx.db.prepare("SELECT value FROM meta WHERE key = 'events_purged_upto'").get() as { value: string }).value);
}

function maxSeq(ctx: AppContext): number {
  return (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
}

function maxInboxSeq(ctx: AppContext, principalId: string): number {
  return (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM inbox_items WHERE principal_id = ?").get(principalId) as { s: number }).s;
}

/** Presents event rows with current snapshots of the thread, message or member they refer to. */
export function presentChanges(ctx: AppContext, rows: EventRow[], viewerId: string): Change[] {
  if (rows.length === 0) return [];
  const threadIds = [...new Set(rows.map((r) => r.thread_id).filter((x): x is string => !!x))];
  const messageIds = [...new Set(rows.map((r) => r.message_id).filter((x): x is string => !!x))];
  const threads = new Map(
    presentThreads(
      ctx,
      threadIds.length ? (ctx.db.prepare(`SELECT * FROM threads WHERE id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds) as ThreadRow[]) : [],
      viewerId,
    ).map((t) => [t.id, t]),
  );
  const messages = new Map(
    presentMessages(
      ctx,
      messageIds.length ? (ctx.db.prepare(`SELECT * FROM messages WHERE id IN (${messageIds.map(() => "?").join(",")})`).all(...messageIds) as MessageRow[]) : [],
      viewerId,
    ).map((m) => [m.id, m]),
  );
  const refs = principalRefs(ctx, rows.flatMap((r) => [r.actor_id, r.subject_id]));
  return rows.map((r) => {
    let member = null;
    if (r.subject_id && r.type.startsWith("member.")) {
      const m = getMembership(ctx, r.board_id, r.subject_id) as MembershipRow | undefined;
      member = m
        ? presentMember(ctx, m, refs)
        : { principal: refs.get(r.subject_id)!, role: "reader" as const, joined_at: r.created_at, access_ends_at: r.created_at, handle: "" };
    }
    return {
      seq: r.seq,
      type: r.type as EventType,
      board_id: r.board_id,
      thread_id: r.thread_id,
      message_id: r.message_id,
      actor: r.actor_id ? (refs.get(r.actor_id) ?? null) : null,
      created_at: r.created_at,
      thread: r.thread_id ? (threads.get(r.thread_id) ?? null) : null,
      message: r.message_id ? (messages.get(r.message_id) ?? null) : null,
      member,
    };
  });
}

export function boardChanges(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  cursor: string | undefined,
  limit = 100,
  threadId?: string,
  filters: ChangeFilters = {},
): ChangesPage {
  return read(ctx, () => {
    requireMember(ctx, actor, boardId);
    const n = Math.min(Math.max(limit, 1), 100);
    if (cursor === undefined || cursor === "") return { changes: [], cursor: encodeCursor("b", boardId, maxSeq(ctx)), has_more: false };
    const { s } = decodeCursor(cursor, "b", boardId);
    if (s < purgedUpto(ctx)) {
      throw new OmbError("cursor_expired", "This cursor is older than the server keeps changes. Reload with list_threads and use its as_of cursor.", {
        resync: true,
      });
    }
    const params: unknown[] = [boardId, s];
    const labels = validateLabels(filters.labels ?? {});
    let sql = Object.keys(labels).length
      ? "SELECT e.* FROM events e LEFT JOIN messages lm ON lm.id = e.message_id LEFT JOIN threads lt ON lt.id = e.thread_id WHERE e.board_id = ? AND e.seq > ? AND e.thread_id IS NOT NULL"
      : "SELECT e.* FROM events e WHERE e.board_id = ? AND e.seq > ?";
    if (threadId) {
      sql += " AND e.thread_id = ?";
      params.push(threadId);
    }
    sql += messageLabelFilter(labels, params, "lm", "lt");
    sql += " ORDER BY e.seq LIMIT ?";
    params.push(n + 1);
    const rows = ctx.db.prepare(sql).all(...params) as EventRow[];
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    const next = more ? last!.seq : Math.max(last?.seq ?? s, maxSeq(ctx));
    return { changes: presentChanges(ctx, page, actor.id), cursor: encodeCursor("b", boardId, next), has_more: more };
  });
}

export function inboxChanges(ctx: AppContext, actor: Actor, cursor: string | undefined, limit = 100): InboxChangesPage {
  return read(ctx, () => {
    const n = Math.min(Math.max(limit, 1), 100);
    if (cursor === undefined || cursor === "") return { items: [], cursor: encodeCursor("i", actor.id, maxInboxSeq(ctx, actor.id)), has_more: false };
    const { s } = decodeCursor(cursor, "i", actor.id);
    const rows = ctx.db.prepare("SELECT * FROM inbox_items WHERE principal_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(actor.id, s, n + 1) as InboxRow[];
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    // A board-scoped token sees only items from its boards; the cursor still moves past the others.
    const visible = page.filter((r) => boardInScope(actor, r.board_id));
    return { items: presentInbox(ctx, visible), cursor: encodeCursor("i", actor.id, last?.seq ?? s), has_more: more };
  });
}

export function getChanges(
  ctx: AppContext,
  actor: Actor,
  input: { board_id?: string | undefined; inbox?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined; labels?: Record<string, string> | undefined },
): ChangesPage | InboxChangesPage {
  if (input.inbox && input.board_id) throw invalid("Pass board_id or inbox: true, not both");
  if (input.inbox && input.labels) throw invalid("labels filters board changes, not the inbox");
  if (input.inbox) return inboxChanges(ctx, actor, input.cursor, input.limit);
  if (!input.board_id) throw invalid("Pass board_id or inbox: true");
  return boardChanges(ctx, actor, input.board_id, input.cursor, input.limit, undefined, { labels: input.labels });
}

/** Long-poll: returns as soon as there are changes after the cursor, or empty after the timeout. */
export async function waitForActivity(
  ctx: AppContext,
  actor: Actor,
  input: {
    board_id?: string | undefined;
    thread_id?: string | undefined;
    inbox?: boolean | undefined;
    cursor: string;
    timeout_seconds?: number | undefined;
    labels?: Record<string, string> | undefined;
  },
  signal?: AbortSignal,
): Promise<ChangesPage | InboxChangesPage> {
  const timeoutMs = Math.min(Math.max(input.timeout_seconds ?? 20, 1), WAIT_MAX_SECONDS) * 1000;
  if (input.inbox && input.labels) throw invalid("labels filters board changes, not the inbox");
  let boardId = input.board_id;
  if (input.thread_id) {
    const { thread } = requireThread(ctx, actor, input.thread_id);
    if (boardId && boardId !== thread.board_id) throw invalid("thread_id is not on that board");
    boardId = thread.board_id;
  }
  // A filtered wait keeps waiting past changes that don't match, moving its cursor along.
  let cursor = input.cursor;
  const fetch = (): ChangesPage | InboxChangesPage =>
    input.inbox ? inboxChanges(ctx, actor, cursor) : boardChanges(ctx, actor, boardId ?? "", cursor, 100, input.thread_id, { labels: input.labels });
  if (!input.inbox && !boardId) throw invalid("Pass board_id, thread_id or inbox: true");
  const first = fetch();
  if (("changes" in first ? first.changes.length : first.items.length) > 0) return first;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const woke = await waitOnce(ctx, actor, input, boardId, Math.max(0, deadline - Date.now()), signal);
    const page = fetch();
    const count = "changes" in page ? page.changes.length : page.items.length;
    if (count > 0 || !input.labels || !woke || signal?.aborted || Date.now() >= deadline) return page;
    cursor = page.cursor;
  }
}

/** Blocks until a matching hub event, the timeout, or abort. Returns true when an event woke it. */
async function waitOnce(
  ctx: AppContext,
  actor: Actor,
  input: { thread_id?: string | undefined; inbox?: boolean | undefined },
  boardId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let woke = false;
  const conn = ctx.connections.register({ principalId: actor.id, kind: "wait", boards: new Set(boardId ? [boardId] : []), close: () => wake() });
  let wake: () => void = () => {};
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const unsub = ctx.hub.subscribe((e: HubEvent) => {
        if (input.inbox && e.kind === "inbox" && e.principalId === actor.id) wakeUp();
        else if (!input.inbox && e.kind === "board" && e.boardId === boardId && (!input.thread_id || e.threadId === input.thread_id)) wakeUp();
        else if ((e.kind === "access" && e.principalId === actor.id && e.boardId === boardId) || (e.kind === "board_deleted" && e.boardId === boardId)) wakeUp();
      });
      function wakeUp() {
        woke = true;
        done();
      }
      const onAbort = () => done();
      signal?.addEventListener("abort", onAbort, { once: true });
      wake = done;
      function done() {
        clearTimeout(timer);
        unsub();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
    });
  } finally {
    ctx.connections.unregister(conn);
  }
  return woke;
}

// ---------- inbox ----------

/** Unread inbox items; a board-scoped token counts only its boards. */
function unreadCount(ctx: AppContext, actor: Actor): number {
  const boards = actor.scope?.boards;
  const extra = boards ? ` AND board_id IN (${boards.map(() => "?").join(",")})` : "";
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM inbox_items WHERE principal_id = ? AND read_at IS NULL${extra}`).get(actor.id, ...(boards ?? [])) as { n: number }).n;
}

export function getInbox(
  ctx: AppContext,
  actor: Actor,
  input: { unread_only?: boolean | undefined; board_id?: string | undefined; page_cursor?: string | undefined; limit?: number | undefined } = {},
): { items: InboxItem[]; unread_count: number; next_page_cursor: string | null; as_of: string } {
  return read(ctx, () => {
    const limit = Math.min(input.limit ?? 25, 100);
    const params: unknown[] = [actor.id];
    let sql = "SELECT * FROM inbox_items WHERE principal_id = ?";
    if (input.unread_only) sql += " AND read_at IS NULL";
    if (input.board_id) {
      sql += " AND board_id = ?";
      params.push(input.board_id);
    }
    const after = decodePage(input.page_cursor, `inbox:${actor.id}`);
    if (after) {
      sql += " AND seq < ?";
      params.push(Number(after[0]));
    }
    sql += " ORDER BY seq DESC LIMIT ?";
    params.push(limit + 1);
    const rows = (ctx.db.prepare(sql).all(...params) as InboxRow[]).filter((r) => !!activeMembership(ctx, r.board_id, actor));
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const unread = unreadCount(ctx, actor);
    return {
      items: presentInbox(ctx, page),
      unread_count: unread,
      next_page_cursor: more && last ? encodePage(`inbox:${actor.id}`, String(last.seq), last.id) : null,
      as_of: encodeCursor("i", actor.id, maxInboxSeq(ctx, actor.id)),
    };
  });
}

export function markRead(ctx: AppContext, actor: Actor, input: { item_ids?: string[] | undefined; up_to_cursor?: string | undefined }): { marked: number; unread_count: number } {
  const now = nowIso(ctx);
  let marked = 0;
  const boards = actor.scope?.boards ?? null;
  const inScope = boards ? ` AND board_id IN (${boards.map(() => "?").join(",")})` : "";
  if (input.item_ids?.length) {
    for (const id of input.item_ids) {
      marked += ctx.db.prepare(`UPDATE inbox_items SET read_at = ? WHERE id = ? AND principal_id = ? AND read_at IS NULL${inScope}`).run(now, id, actor.id, ...(boards ?? [])).changes;
    }
  }
  if (input.up_to_cursor) {
    const { s } = decodeCursor(input.up_to_cursor, "i", actor.id);
    marked += ctx.db.prepare(`UPDATE inbox_items SET read_at = ? WHERE principal_id = ? AND seq <= ? AND read_at IS NULL${inScope}`).run(now, actor.id, s, ...(boards ?? [])).changes;
  }
  if (!input.item_ids?.length && !input.up_to_cursor) throw invalid("Pass item_ids or up_to_cursor");
  const unread = unreadCount(ctx, actor);
  return { marked, unread_count: unread };
}

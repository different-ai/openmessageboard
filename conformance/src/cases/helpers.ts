import type { Change, ChangesPage, ErrorBody, InboxChangesPage, InboxItem, ToolOutput } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { Ctx } from "../harness.ts";
import type { McpSession } from "../mcp.ts";
import { newKey } from "../util.ts";

export function boardPage(page: ToolOutput<"get_changes">, where: string): ChangesPage {
  if (!("changes" in page)) throw new Failure(`${where}: expected a board ChangesPage, got an inbox page`);
  return page;
}

export function inboxPage(page: ToolOutput<"get_changes">, where: string): InboxChangesPage {
  if (!("items" in page)) throw new Failure(`${where}: expected an InboxChangesPage, got a board page`);
  return page;
}

/** The board's current cursor (get_changes without a cursor). */
export async function boardCursor(s: McpSession, boardId: string): Promise<string> {
  const page = boardPage(await s.ok("get_changes", { board_id: boardId }), "get_changes without cursor");
  check(page.changes.length === 0, "get_changes without a cursor returns no changes (05 §Cursors)", page);
  check(page.has_more === false, "get_changes without a cursor returns has_more: false (05 §Cursors)");
  return page.cursor;
}

export async function inboxCursor(s: McpSession): Promise<string> {
  return inboxPage(await s.ok("get_changes", { inbox: true }), "get_changes inbox without cursor").cursor;
}

/** Reads every board change after `cursor` (step 2 of the client algorithm). */
export async function readAll(s: McpSession, boardId: string, cursor: string, limit?: number): Promise<{ changes: Change[]; cursor: string; pages: number }> {
  const changes: Change[] = [];
  let pages = 0;
  for (;;) {
    const page = boardPage(await s.ok("get_changes", limit ? { board_id: boardId, cursor, limit } : { board_id: boardId, cursor }), "get_changes");
    pages++;
    changes.push(...page.changes);
    check(typeof page.cursor === "string" && page.cursor.length > 0, "get_changes returns a cursor");
    cursor = page.cursor;
    if (!page.has_more) break;
    if (pages > 200) throw new Failure("get_changes kept returning has_more: true");
  }
  return { changes, cursor, pages };
}

export async function readInbox(s: McpSession, cursor: string): Promise<{ items: InboxItem[]; cursor: string }> {
  const items: InboxItem[] = [];
  for (let i = 0; i < 50; i++) {
    const page = inboxPage(await s.ok("get_changes", { inbox: true, cursor }), "get_changes inbox");
    items.push(...page.items);
    cursor = page.cursor;
    if (!page.has_more) break;
  }
  return { items, cursor };
}

export async function startThread(
  s: McpSession,
  boardId: string,
  title: string,
  body: string,
  extra: { mentions?: string[]; labels?: Record<string, string>; task?: boolean; assignee?: string } = {},
): Promise<ToolOutput<"start_thread">> {
  return s.ok("start_thread", { board_id: boardId, title, body, idempotency_key: newKey(), ...extra });
}

export async function reply(s: McpSession, threadId: string, body: string, extra: { mentions?: string[]; reply_to?: string } = {}): Promise<ToolOutput<"reply">> {
  return s.ok("reply", { thread_id: threadId, body, idempotency_key: newKey(), ...extra });
}

/** Fails if an error body mentions any of the given strings (board IDs, names, titles). */
export function assertNoLeak(err: ErrorBody | unknown, secrets: (string | undefined)[], where: string): void {
  const text = JSON.stringify(err);
  for (const s of secrets) {
    if (s && s.length >= 3 && text.includes(s)) throw new Failure(`${where}: the error reveals "${s}" (02 §Existence is not revealed / §Redeeming an invite)`, err);
  }
}

export function reasonOf(err: ErrorBody): string | undefined {
  const r = (err.details as { reason?: unknown } | undefined)?.reason;
  return typeof r === "string" ? r : undefined;
}

/** Owner's board. */
export const ownerBoard = (ctx: Ctx) => ctx.boardOf("owner");

/** Maya is a contributor on the owner's board (joins by email invite when needed). */
export function mayaOnOwnerBoard(ctx: Ctx): Promise<string> {
  return ctx.fixture("maya-on-owner-board", async () => {
    const board = await ownerBoard(ctx);
    if (await ctx.isMember("maya", board)) return board;
    const owner = await ctx.session("owner");
    const maya = await ctx.session("maya");
    const { invite } = await owner.ok("create_invite", { board_id: board, audience: "email", value: ctx.email("maya"), role: "contributor" });
    check(invite.url, "create_invite returns the invite URL");
    const joined = await maya.ok("redeem_invite", { invite: invite.url });
    check(joined.board.id === board, "redeem_invite returns the invited board");
    return board;
  });
}

/** The `quota` principal is a reader on the owner's board (joins by domain invite when needed). */
export function quotaReaderOnOwnerBoard(ctx: Ctx): Promise<string> {
  return ctx.fixture("quota-reader-on-owner-board", async () => {
    const board = await ownerBoard(ctx);
    const quota = await ctx.session("quota");
    const w = await quota.ok("whoami", {});
    const m = w.memberships.find((x) => x.board_id === board);
    if (m) {
      if (m.role !== "reader") throw new Failure(`quota is already a ${m.role} on the owner's board; the reader checks need a fresh server`);
      return board;
    }
    const owner = await ctx.session("owner");
    const domain = ctx.email("owner").split("@")[1]!;
    const { invite } = await owner.ok("create_invite", { board_id: board, audience: "domain", value: domain, role: "reader" });
    check(invite.url, "create_invite returns the invite URL");
    await quota.ok("redeem_invite", { invite: invite.url });
    return board;
  });
}

/** A discussion thread on the owner's board, started by the owner, that Maya can read. */
export function sharedThread(ctx: Ctx): Promise<{ threadId: string; title: string; rootId: string; boardId: string }> {
  return ctx.fixture("shared-thread", async () => {
    const boardId = await mayaOnOwnerBoard(ctx);
    const owner = await ctx.session("owner");
    const title = `Conformance run ${ctx.runId}: shared thread`;
    const r = await startThread(owner, boardId, title, "Shared thread for the conformance run.");
    return { threadId: r.thread.id, title, rootId: r.message.id, boardId };
  });
}

export function messagesOf(changes: Change[], threadId?: string): string[] {
  const ids: string[] = [];
  for (const c of changes) {
    if ((c.type === "message.created" || c.type === "thread.created") && c.message && (!threadId || c.thread_id === threadId)) ids.push(c.message.id);
  }
  return ids;
}

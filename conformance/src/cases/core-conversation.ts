/** core: posting, idempotency, mentions, follows, inbox, changes, waits, delete, search, resources, limits. */
import type { AllowanceUsage } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { contractIssues, type McpSession } from "../mcp.ts";
import { rpcErrorCode } from "../http.ts";
import { newKey, sleep } from "../util.ts";
import {
  boardCursor,
  boardPage,
  inboxCursor,
  inboxPage,
  mayaOnOwnerBoard,
  messagesOf,
  ownerBoard,
  readAll,
  readInbox,
  reply,
  sharedThread,
  startThread,
} from "./helpers.ts";

async function postsUsed(s: McpSession, boardId: string): Promise<AllowanceUsage> {
  const u = await s.ok("get_usage", { board_id: boardId });
  const posts = u.allowances.find((a) => a.allowance === "posts");
  if (!posts) throw new Failure("get_usage has no posts allowance");
  return posts;
}

async function allMessages(s: McpSession, threadId: string) {
  const out = [];
  let page_cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await s.ok("get_thread", page_cursor ? { thread_id: threadId, page_cursor, limit: 200 } : { thread_id: threadId, limit: 200 });
    out.push(...r.messages);
    if (!r.next_page_cursor) break;
    page_cursor = r.next_page_cursor;
  }
  return out;
}

const ids = async (ctx: Ctx) => ({ owner: (await ctx.me("owner")).id, maya: (await ctx.me("maya")).id, outsider: (await ctx.me("outsider")).id });

export const coreConversationCases: CaseDef[] = [
  {
    id: "core.idempotent-post",
    profile: "core",
    title: "Retrying a post with the same idempotency key yields one message, one change and one quota charge",
    covers: ["R03-01", "R06-14", "R06-15"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const before = await postsUsed(owner, board);
      const c0 = await boardCursor(owner, board);
      const args = { board_id: board, title: `Idempotency ${ctx.runId}`, body: "Posted once, retried once.", idempotency_key: newKey() };
      const a = await owner.ok("start_thread", args);
      const b = await owner.ok("start_thread", args);
      check(a.thread.id === b.thread.id && a.message.id === b.message.id, "a retry with the same key must return the original thread and message");
      await owner.fails("start_thread", { ...args, body: "Different body, same key" }, "idempotency_conflict");
      const key = newKey();
      const replyArgs = { thread_id: a.thread.id, body: "Concurrent duplicate reply.", idempotency_key: key };
      const [r1, r2] = await Promise.all([owner.ok("reply", replyArgs), owner.ok("reply", replyArgs)]);
      check(r1.message.id === r2.message.id, "concurrent requests with the same key must produce one message");
      const after = await postsUsed(owner, board);
      check(after.used === before.used + 2, `posts used went from ${before.used} to ${after.used}; expected +2 (one thread, one reply)`);
      const { changes } = await readAll(owner, board, c0);
      const created = changes.filter((c) => c.thread_id === a.thread.id && (c.type === "thread.created" || c.type === "message.created"));
      check(created.length === 2, `expected 2 changes for the thread (thread.created + message.created), got ${created.length}: ${created.map((c) => c.type).join(", ")}`);
      const messages = await allMessages(owner, a.thread.id);
      check(messages.length === 2, `the thread holds ${messages.length} messages, expected 2`);
    },
  },
  {
    id: "core.message-size",
    profile: "core",
    title: "Bodies are limited in UTF-8 bytes; oversize posts fail with message_too_large and cost nothing",
    covers: ["R03-03", "R03-04"],
    async run(ctx) {
      const limit = (await ctx.limitsOf("owner")).message_bytes!;
      if (limit > 1024 * 1024) ctx.skip(`message_bytes is ${limit}; too large to test`);
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const t = await startThread(owner, board, `Message size ${ctx.runId}`, "Size checks.");
      const before = await postsUsed(owner, board);
      const e = await owner.fails("reply", { thread_id: t.thread.id, body: "x".repeat(limit + 1), idempotency_key: newKey() }, "message_too_large");
      const d = e.details as { limit?: unknown } | undefined;
      if (d?.limit !== limit) ctx.note(`message_too_large details.limit is ${String(d?.limit)}, expected ${limit}`);
      await owner.fails("reply", { thread_id: t.thread.id, body: "é".repeat(Math.floor(limit / 2) + 1), idempotency_key: newKey() }, "message_too_large");
      const mid = await postsUsed(owner, board);
      check(mid.used === before.used, "rejected posts must not be charged");
      await reply(owner, t.thread.id, "y".repeat(limit));
    },
  },
  {
    id: "core.invalid-arguments",
    profile: "core",
    title: "Invalid arguments are tool errors with invalid_argument, not JSON-RPC errors",
    covers: ["R03-05", "R03-08", "R05-07", "R06-12", "R06-13"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const { outsider } = await ids(ctx);
      await owner.fails("start_thread", { board_id: board, title: "t".repeat(201), body: "x", idempotency_key: newKey() }, "invalid_argument");
      const t1 = await startThread(owner, board, `Validation A ${ctx.runId}`, "A");
      const t2 = await startThread(owner, board, `Validation B ${ctx.runId}`, "B");
      await owner.fails("reply", { thread_id: t2.thread.id, body: "x", reply_to: t1.message.id, idempotency_key: newKey() }, "invalid_argument");
      await owner.fails("reply", { thread_id: t2.thread.id, body: "x", mentions: [outsider], idempotency_key: newKey() }, "invalid_argument");
      await owner.fails("get_changes", { board_id: board, inbox: true }, "invalid_argument");
      await owner.fails("get_changes", {}, "invalid_argument");
      await owner.fails("mark_read", {}, "invalid_argument");
    },
  },
  {
    id: "core.mentions-inbox",
    profile: "core",
    title: "Mentions create inbox items; mark_read by ID and up to a cursor",
    covers: ["R03-32", "R03-33", "R03-36"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const who = await ids(ctx);
      const ic0 = await inboxCursor(maya);
      const t = await startThread(owner, board, `Mentions ${ctx.runId}`, "Can you take a look?", { mentions: [who.maya] });
      const inbox = await maya.ok("get_inbox", { unread_only: true });
      const item = inbox.items.find((i) => i.message?.id === t.message.id);
      check(item, "maya's inbox has no item for the message that mentioned her");
      check(item.kind === "mention", `item kind is ${item.kind}, expected mention`);
      check(item.read_at === null && item.thread_id === t.thread.id && item.board_id === board, "item is unread and points at the thread");
      const ownInbox = await owner.ok("get_inbox", {});
      check(!ownInbox.items.some((i) => i.message?.id === t.message.id), "the author must not get an inbox item for its own message");
      const { items } = await readInbox(maya, ic0);
      check(items.some((i) => i.id === item.id), "get_changes(inbox) after the earlier inbox cursor includes the new item");
      const unreadThreads = await maya.ok("list_threads", { board_id: board, filter: "unread" });
      const listed = unreadThreads.threads.find((x) => x.id === t.thread.id);
      check(listed && listed.unread_count >= 1, "list_threads filter unread includes the thread with unread_count >= 1");
      const m1 = await maya.ok("mark_read", { item_ids: [item.id] });
      check(m1.marked === 1, `mark_read marked ${m1.marked}, expected 1`);
      const again = await maya.ok("mark_read", { item_ids: [item.id] });
      check(again.marked === 0, "marking an already read item marks nothing");
      const after = await maya.ok("get_inbox", {});
      const read = after.items.find((i) => i.id === item.id);
      check(read && read.read_at !== null, "the item now has read_at");
      check(after.unread_count === m1.unread_count, "mark_read reports the new unread_count");
      const r = await reply(owner, t.thread.id, "Second ping.", { mentions: [who.maya] });
      const { items: newer, cursor } = await readInbox(maya, inbox.as_of);
      check(newer.some((i) => i.message?.id === r.message.id), "the second mention reaches the inbox log");
      const m2 = await maya.ok("mark_read", { up_to_cursor: cursor });
      check(m2.marked >= 1, "mark_read up_to_cursor marks the newer item");
      const final = await maya.ok("get_inbox", { unread_only: true });
      check(!final.items.some((i) => i.message?.id === r.message.id), "items up to the cursor are read");
    },
  },
  {
    id: "core.follow-reply-inbox",
    profile: "core",
    title: "Starting or replying follows a thread; followers get reply items; unfollow stops them; mention wins over reply",
    covers: ["R03-30", "R03-31", "R03-34"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const who = await ids(ctx);
      const t = await startThread(maya, board, `Follows ${ctx.runId}`, "Thoughts on the rollout?");
      check(t.thread.following === true, "starting a thread follows it");
      const r1 = await reply(owner, t.thread.id, "Looks fine to me.");
      const inbox1 = await maya.ok("get_inbox", {});
      const it = inbox1.items.find((i) => i.message?.id === r1.message.id);
      check(it && it.kind === "reply", "a reply in a followed thread creates a reply item for the follower");
      const ownerView = await owner.ok("get_thread", { thread_id: t.thread.id });
      check(ownerView.thread.following === true, "replying follows the thread");
      const r2 = await reply(maya, t.thread.id, "Thanks.");
      const ownerInbox = await owner.ok("get_inbox", {});
      check(ownerInbox.items.some((i) => i.message?.id === r2.message.id && i.kind === "reply"), "the replier now gets reply items");
      const off = await maya.ok("set_follow", { thread_id: t.thread.id, following: false });
      check(off.following === false, "set_follow echoes the new state");
      const r3 = await reply(owner, t.thread.id, "One more thing.");
      const inbox2 = await maya.ok("get_inbox", {});
      check(!inbox2.items.some((i) => i.message?.id === r3.message.id), "after unfollowing, replies create no items");
      await maya.ok("set_follow", { thread_id: t.thread.id, following: true });
      const r4 = await reply(owner, t.thread.id, "Please confirm.", { mentions: [who.maya] });
      const inbox3 = await maya.ok("get_inbox", {});
      const forR4 = inbox3.items.filter((i) => i.message?.id === r4.message.id);
      check(forR4.length === 1 && forR4[0]!.kind === "mention", `a follower who is mentioned gets exactly one mention item, got ${forR4.map((i) => i.kind).join(", ") || "none"}`);
      const t2 = await startThread(owner, board, `Mention only ${ctx.runId}`, "FYI", { mentions: [who.maya] });
      const view = await maya.ok("get_thread", { thread_id: t2.thread.id });
      check(view.thread.following === false, "being mentioned does not follow the thread");
    },
  },
  {
    id: "core.changes-order",
    profile: "core",
    title: "get_changes returns each change once, in seq order, with stable paging",
    covers: ["R05-05", "R05-06", "R05-17"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const c0 = await boardCursor(owner, board);
      const t = await startThread(owner, board, `Ordering ${ctx.runId}`, "root");
      const replies = [];
      for (let i = 1; i <= 3; i++) replies.push((await reply(owner, t.thread.id, `reply ${i}`)).message.id);
      const all = await readAll(owner, board, c0);
      const mine = all.changes.filter((c) => c.thread_id === t.thread.id);
      check(mine.length === 4, `expected 4 changes for the thread, got ${mine.length}: ${mine.map((c) => c.type).join(", ")}`);
      check(mine[0]!.type === "thread.created" && mine[0]!.message?.id === t.message.id && mine[0]!.thread?.id === t.thread.id, "start_thread emits one thread.created carrying the thread and its root message");
      check(JSON.stringify(mine.slice(1).map((c) => c.message?.id)) === JSON.stringify(replies), "replies appear as message.created in posting order");
      const ownerId = (await ctx.me("owner")).id;
      check(mine.every((c) => c.actor?.id === ownerId), "each change names the posting principal as actor");
      const seqs = all.changes.map((c) => c.seq);
      check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), `seq values are not strictly increasing: ${seqs.join(", ")}`);
      const paged = await readAll(owner, board, c0, 1);
      check(JSON.stringify(paged.changes.map((c) => c.seq)) === JSON.stringify(seqs), "paging with limit 1 returns the same sequence");
      check(paged.pages >= seqs.length, "limit 1 returns one change per page");
      const tail = boardPage(await owner.ok("get_changes", { board_id: board, cursor: all.cursor }), "get_changes at the end");
      check(tail.changes.length === 0 && tail.has_more === false, "reading from the last cursor returns nothing new");
    },
  },
  {
    id: "core.cursor-errors",
    profile: "core",
    title: "Cursors are opaque and scoped: forged or foreign cursors fail with invalid_argument",
    covers: ["R05-04", "R05-07"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const mayaBoard = await ctx.boardOf("maya");
      await maya.fails("get_changes", { board_id: board, cursor: "not-a-cursor" }, "invalid_argument");
      const c = await boardCursor(maya, board);
      await maya.fails("get_changes", { board_id: mayaBoard, cursor: c }, "invalid_argument");
      await maya.fails("get_changes", { inbox: true, cursor: c }, "invalid_argument");
      const ic = await inboxCursor(maya);
      await owner.fails("get_changes", { inbox: true, cursor: ic }, "invalid_argument");
    },
  },
  {
    id: "core.cursor-expired",
    profile: "core",
    title: "A cursor older than the retention window fails with cursor_expired",
    covers: [],
    placeholder: true,
    async run(ctx) {
      const info = await ctx.discovery();
      ctx.skip(`cannot be forced through the public interface: event_retention_days is ${info.limits.event_retention_days}; clients are expected to reload via list_threads/get_thread as_of`);
    },
  },
  {
    id: "core.wait-for-activity",
    profile: "core",
    title: "wait_for_activity returns when another principal posts, immediately when changes exist, and on timeout",
    covers: ["R05-19", "R05-21", "R05-23", "R05-24"],
    timeoutMs: 150_000,
    async run(ctx) {
      const t = await sharedThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const who = await ids(ctx);
      await owner.reserveWrites(5);
      const c = await boardCursor(maya, t.boardId);
      const started = Date.now();
      const waiting = maya.ok("wait_for_activity", { board_id: t.boardId, cursor: c, timeout_seconds: 20 });
      await sleep(1500);
      const r = await reply(owner, t.threadId, "Waking the waiter.");
      const woke = boardPage(await waiting, "wait_for_activity");
      const elapsed = Date.now() - started;
      check(messagesOf(woke.changes).includes(r.message.id), "the wait returned without the new message");
      check(elapsed < 12_000, `the wait returned after ${elapsed} ms; it should return soon after the post, not at the timeout`);
      const t0 = Date.now();
      const immediate = boardPage(await maya.ok("wait_for_activity", { board_id: t.boardId, cursor: c, timeout_seconds: 20 }), "wait_for_activity");
      check(Date.now() - t0 < 5000 && immediate.changes.length > 0, "a wait with changes already after the cursor returns immediately");
      const t1 = Date.now();
      const quiet = boardPage(await maya.ok("wait_for_activity", { board_id: t.boardId, cursor: woke.cursor, timeout_seconds: 2 }), "wait_for_activity");
      const quietMs = Date.now() - t1;
      check(quiet.changes.length === 0 && quiet.has_more === false, "a wait with no activity returns an empty page");
      check(quietMs >= 1500 && quietMs < 10_000, `a 2 s wait took ${quietMs} ms`);
      const other = await startThread(owner, t.boardId, `Wait filter ${ctx.runId}`, "not the watched thread");
      void other;
      await owner.reserveWrites(4);
      const c2 = await boardCursor(maya, t.boardId);
      const threadWait = maya.ok("wait_for_activity", { thread_id: t.threadId, cursor: c2, timeout_seconds: 20 });
      await sleep(800);
      await startThread(owner, t.boardId, `Wait filter 2 ${ctx.runId}`, "still not the watched thread");
      await sleep(800);
      const r2 = await reply(owner, t.threadId, "This one is in the watched thread.");
      const tw = boardPage(await threadWait, "wait_for_activity thread");
      check(messagesOf(tw.changes).includes(r2.message.id), "a thread wait returns the thread's new message");
      check(tw.changes.every((ch) => ch.thread_id === t.threadId), "a thread wait returns only that thread's changes");
      const ic = await inboxCursor(maya);
      const inboxWait = maya.ok("wait_for_activity", { inbox: true, cursor: ic, timeout_seconds: 20 });
      await sleep(1000);
      const r3 = await reply(owner, t.threadId, "Mentioning you.", { mentions: [who.maya] });
      const iw = inboxPage(await inboxWait, "wait_for_activity inbox");
      check(iw.items.some((i) => i.message?.id === r3.message.id), "an inbox wait returns the new mention");
    },
  },
  {
    id: "core.delete-tombstone",
    profile: "core",
    title: "Delete leaves a tombstone everywhere; only the author or the owner may delete",
    covers: ["R03-37", "R03-38", "R03-40", "R05-01"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const t = await startThread(owner, board, `Delete ${ctx.runId}`, "Thread for delete checks.");
      const c0 = await boardCursor(owner, board);
      const word = `omb${ctx.runId}secretword`;
      const r1 = await reply(owner, t.thread.id, `Oops, pasted ${word} here.`);
      await maya.fails("delete_message", { message_id: r1.message.id }, "forbidden");
      const d = await owner.ok("delete_message", { message_id: r1.message.id });
      check(d.message.id === r1.message.id && d.message.deleted === true && d.message.body === null, "delete returns the tombstone (same id, deleted, null body)");
      check(d.message.author.id === r1.message.author.id && d.message.created_at === r1.message.created_at, "the tombstone keeps author and created_at");
      check(d.message.mentions.length === 0, "the tombstone has no mentions");
      const again = await owner.ok("delete_message", { message_id: r1.message.id });
      check(again.message.deleted === true, "deleting again returns the tombstone");
      const msgs = await allMessages(owner, t.thread.id);
      const shown = msgs.find((m) => m.id === r1.message.id);
      check(shown && shown.deleted && shown.body === null, "get_thread shows the tombstone in place");
      const { changes } = await readAll(owner, board, c0);
      const created = changes.find((c) => c.type === "message.created" && c.message_id === r1.message.id);
      const deleted = changes.filter((c) => c.type === "message.deleted" && c.message_id === r1.message.id);
      check(deleted.length === 1, `expected one message.deleted change, got ${deleted.length}`);
      check(created && created.message?.deleted === true && created.message.body === null, "the earlier message.created change now shows the tombstone (05: current state)");
      check(!JSON.stringify(changes).includes(word), "the deleted body is not readable through get_changes");
      const own = await reply(maya, t.thread.id, "My own message.");
      await maya.ok("delete_message", { message_id: own.message.id });
      const theirs = await reply(maya, t.thread.id, "Owner can remove this.");
      await owner.ok("delete_message", { message_id: theirs.message.id });
      const search = await owner.call("search_messages", { board_id: board, query: word });
      if (search.ok) check(!search.data.results.some((x) => x.message.id === r1.message.id), "search must not find deleted messages");
      else ctx.note(`search_messages failed (${search.error.code}); deleted-message search not checked`);
    },
  },
  {
    id: "core.search",
    profile: "core",
    title: "search_messages finds messages on one board for members only",
    covers: ["R03-41", "R03-42"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const word = `zebra${ctx.runId}`;
      const t = await startThread(owner, board, `Search ${ctx.runId}`, `The ${word} migration starts Monday.`);
      const r = await owner.ok("search_messages", { board_id: board, query: word });
      const hit = r.results.find((x) => x.message.id === t.message.id);
      check(hit, `searching for "${word}" did not find the message`);
      check(hit.thread_title === t.thread.title, "results carry the thread title");
      if (!(await ctx.isMember("outsider", board))) await (await ctx.session("outsider")).fails("search_messages", { board_id: board, query: word }, "not_found");
    },
  },
  {
    id: "core.list-members",
    profile: "core",
    title: "list_members shows roles, unique handles and no emails",
    covers: ["R01-04", "R02-13"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const who = await ids(ctx);
      const { members } = await maya.ok("list_members", { board_id: board });
      const o = members.find((m) => m.principal.id === who.owner);
      const m = members.find((x) => x.principal.id === who.maya);
      check(o && o.role === "owner", "the owner is listed with role owner");
      check(m && m.role === "contributor", "maya is listed as contributor");
      const handles = members.map((x) => x.handle);
      check(new Set(handles).size === handles.length, "handles are unique within the board");
      for (const h of handles) check(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(h), `handle "${h}" does not match ^[a-z0-9][a-z0-9_-]{0,31}$`);
      const text = JSON.stringify(members);
      for (const n of ["owner", "maya"] as const) check(!text.includes(ctx.email(n)), "list_members must not expose emails (01)");
      for (const x of members) {
        if (x.principal.kind === "agent") check(x.principal.via !== null, "agents carry via (their owner)");
        else check(x.principal.via === null, "non-agents have via: null");
      }
    },
  },
  {
    id: "core.resources",
    profile: "core",
    title: "Board, thread and inbox resources: templates, list, read with ttlMs/cacheScope, -32602 for unknown",
    covers: ["R06-18", "R06-19", "R06-20"],
    async run(ctx) {
      const t = await sharedThread(ctx);
      const maya = await ctx.session("maya");
      const base = await ctx.resourceBase();
      const tl = await maya.rpc("resources/templates/list");
      check(tl.result, `resources/templates/list failed: ${JSON.stringify(tl.error)}`);
      const templates = ((tl.result.resourceTemplates ?? []) as { uriTemplate: string }[]).map((x) => x.uriTemplate);
      check(templates.some((u) => new RegExp(`^${escape(base)}/b/\\{[^}]+\\}$`).test(u)), `no board template {base}/b/{board_id} in ${templates.join(", ")}`);
      check(templates.some((u) => new RegExp(`^${escape(base)}/b/\\{[^}]+\\}/t/\\{[^}]+\\}$`).test(u)), "no thread template {base}/b/{board_id}/t/{thread_id}");
      const rl = await maya.rpc("resources/list");
      check(rl.result, `resources/list failed: ${JSON.stringify(rl.error)}`);
      const uris = ((rl.result.resources ?? []) as { uri: string }[]).map((x) => x.uri);
      check(uris.includes(`${base}/me/inbox`), "resources/list includes the inbox");
      check(uris.includes(`${base}/b/${t.boardId}`), "resources/list includes boards the caller belongs to");
      const reads: [string, (j: Record<string, unknown>) => boolean, string][] = [
        [`${base}/b/${t.boardId}`, (j) => (j.board as { id?: string } | undefined)?.id === t.boardId && Array.isArray(j.threads), "{board, threads, ...}"],
        [`${base}/b/${t.boardId}/t/${t.threadId}`, (j) => (j.thread as { id?: string } | undefined)?.id === t.threadId && Array.isArray(j.messages), "{thread, messages, ...}"],
        [`${base}/me/inbox`, (j) => Array.isArray(j.items), "{items, ...}"],
      ];
      for (const [uri, ok, shape] of reads) {
        const r = await maya.rpc("resources/read", { uri });
        check(r.result, `resources/read ${uri} failed: ${JSON.stringify(r.error)}`);
        const c = ((r.result.contents ?? []) as { mimeType?: string; text?: string }[])[0];
        check(c && c.mimeType === "application/json", `resources/read ${uri} must return application/json text`);
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(c.text ?? "") as Record<string, unknown>;
        } catch {
          throw new Failure(`resources/read ${uri} text is not JSON`);
        }
        check(ok(json), `resources/read ${uri} content is not ${shape}`);
        check(typeof r.result.ttlMs === "number" && (r.result.ttlMs as number) <= 5000, `resources/read ${uri} needs ttlMs <= 5000`);
        check(r.result.cacheScope === "private", `resources/read ${uri} needs cacheScope "private"`);
      }
      const mayaBoard = await ctx.boardOf("maya");
      for (const uri of [`${base}/b/b_unknown000000`, `${base}/b/${mayaBoard}/t/${t.threadId}`, `${base}/nonsense`]) {
        const r = await maya.rpc("resources/read", { uri });
        check(r.error && r.error.code === -32602, `resources/read ${uri} should fail with -32602, got ${JSON.stringify(r.error ?? r.result).slice(0, 200)}`);
        const code = rpcErrorCode(r.error);
        check(code === undefined || code === "not_found", `resources/read ${uri}: data.code ${code}`);
      }
    },
  },
  {
    id: "core.quota",
    profile: "core",
    title: "The last allowed post succeeds, the next gets quota_exceeded with details, and reads keep working",
    covers: ["R06-17", "R07-01", "R07-03", "R07-04", "R07-05"],
    timeoutMs: 600_000,
    async run(ctx) {
      const limit = (await ctx.limitsOf("quota")).posts_per_month!;
      if (limit > 200) ctx.skip(`posts_per_month is ${limit}; start the server with a small limit such as OMB_LIMIT_POSTS_PER_MONTH=5 to run this case`);
      const quota = await ctx.session("quota");
      const board = await ctx.boardOf("quota");
      let used = (await postsUsed(quota, board)).used;
      if (used >= limit) ctx.skip(`the quota identity's board already used ${used} of ${limit} posts this month; start from a fresh data directory`);
      let threadId: string | undefined;
      let lastArgs: { tool: "start_thread" | "reply"; args: Record<string, unknown> } | undefined;
      const post = async () => {
        const key = newKey();
        lastArgs = threadId
          ? { tool: "reply", args: { thread_id: threadId, body: `post at ${used}`, idempotency_key: key } }
          : { tool: "start_thread", args: { board_id: board, title: `Quota ${ctx.runId}`, body: "post", idempotency_key: key } };
        const r = await quota.callRaw(lastArgs.tool, lastArgs.args);
        if (r.ok && !threadId) threadId = (r.data as { thread: { id: string } }).thread.id;
        return r;
      };
      while (used < limit - 1) {
        const r = await post();
        if (!r.ok) throw new Failure(`post ${used + 1} of ${limit} failed early with ${r.error.code}: ${r.error.message}`);
        used++;
      }
      const last = await post();
      const lastCall = lastArgs!;
      if (!last.ok) throw new Failure(`the last allowed post (${limit} of ${limit}) failed with ${last.error.code}`);
      const warning = (last.data as { usage_warning?: AllowanceUsage[] }).usage_warning;
      check(warning?.some((w) => w.allowance === "posts" && w.warning), "a write at or above 80% of an allowance includes usage_warning for posts (07)");
      const over = await post();
      check(!over.ok, "the post after the limit succeeded");
      if (over.ok) return;
      check(over.error.code === "quota_exceeded", `the post after the limit returned ${over.error.code}, expected quota_exceeded`);
      const d = (over.error.details ?? {}) as { allowance?: unknown; used?: unknown; limit?: unknown; resets_at?: unknown };
      check(d.allowance === "posts", `details.allowance is ${String(d.allowance)}, expected posts`);
      check(d.used === limit && d.limit === limit, `details used/limit are ${String(d.used)}/${String(d.limit)}, expected ${limit}/${limit}`);
      const reset = Date.parse(String(d.resets_at));
      const now = new Date(ctx.serverNow());
      const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      check(Number.isFinite(reset) && Math.abs(reset - nextMonth) < 60_000, `details.resets_at ${String(d.resets_at)} should be the first instant of next UTC month`);
      const replay = await quota.callRaw(lastCall.tool, lastCall.args);
      check(replay.ok, "retrying the last accepted post with its key still returns the original result after the quota is reached (06 §Idempotency)");
      await quota.ok("list_threads", { board_id: board });
      if (threadId) await quota.ok("get_thread", { thread_id: threadId });
      await quota.ok("get_changes", { board_id: board });
      const usage = await postsUsed(quota, board);
      check(usage.used === limit && usage.warning, "get_usage shows the allowance used up with warning: true");
    },
  },
  {
    id: "core.member-limit",
    profile: "core",
    title: "A full board refuses new members with member_limit_reached",
    covers: ["R02-24"],
    async run(ctx) {
      const limit = (await ctx.limitsOf("quota")).members_per_board!;
      if (limit > 6) ctx.skip(`members_per_board is ${limit}; start the server with OMB_LIMIT_MEMBERS_PER_BOARD=4 to run this case`);
      const quota = await ctx.session("quota");
      const board = await ctx.boardOf("quota");
      const { invite } = await quota.ok("create_invite", { board_id: board, audience: "link", role: "reader" });
      let count = (await quota.ok("list_members", { board_id: board })).members.length;
      for (const n of ["owner", "maya", "outsider", "lookalike"] as const) {
        if (await ctx.isMember(n, board)) continue;
        const r = await (await ctx.session(n)).call("redeem_invite", { invite: invite.url! });
        if (r.ok) {
          count++;
          check(count <= limit, `the board accepted member ${count} with members_per_board ${limit}`);
          continue;
        }
        check(r.error.code === "member_limit_reached", `${n} got ${r.error.code}, expected member_limit_reached (board has ${count} of ${limit})`);
        check(count === limit, `member_limit_reached with ${count} of ${limit} seats used`);
        const d = r.error.details as { limit?: unknown } | undefined;
        if (d?.limit !== limit) ctx.note(`details.limit is ${String(d?.limit)}, expected ${limit}`);
        return;
      }
      ctx.skip(`could not fill the board (${count} of ${limit}); not enough unused identities`);
    },
  },
  {
    id: "core.agent-caps",
    profile: "core",
    title: "Agent daily cap and loop guard",
    covers: [],
    placeholder: true,
    async run(ctx) {
      ctx.skip("needs agents added to a board by their owner, which has no MCP path in v0.1");
    },
  },
];

/** Reports wire-contract issues collected across every call in the run. */
export const contractCase: CaseDef = {
  id: "core.tool-result-shape",
  profile: "core",
  title: "Every tool result carried a text summary and well-formed errors",
  covers: ["R06-10", "R06-12"],
  async run(ctx) {
    if (contractIssues.size) throw new Failure([...contractIssues.values()].join("; "));
    ctx.note("checked on every tool call made by this run");
  },
};

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

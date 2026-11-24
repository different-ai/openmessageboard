/**
 * Message filters, reads and waits (core), and scheduled posts and watchers (automation profile).
 * Spec: 05 §Filters, §read_messages, §wait_for_activity; 11.
 */
import type { Change, ErrorBody, Message, ToolOutput } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import type { McpSession } from "../mcp.ts";
import { sleep, until } from "../util.ts";
import { boardCursor, boardPage, mayaOnOwnerBoard, quotaReaderOnOwnerBoard, readAll, reply, startThread } from "./helpers.ts";

const ids = (r: { messages: Message[] }) => r.messages.map((m) => m.id);

function sameIds(got: string[], want: string[], what: string): void {
  check(JSON.stringify(got) === JSON.stringify(want), `${what}: got [${got.join(", ")}], expected [${want.join(", ")}]`);
}

/** A thread on the owner's board with a root by the owner, a reply by maya that mentions the owner, and one by the owner. */
function filterThread(ctx: Ctx) {
  return ctx.fixture("filter-thread", async () => {
    const boardId = await mayaOnOwnerBoard(ctx);
    const owner = await ctx.session("owner");
    const maya = await ctx.session("maya");
    const ownerId = (await ctx.me("owner")).id;
    const word = `Quokka${ctx.runId}x`;
    const root = await startThread(owner, boardId, `Filters ${ctx.runId}`, "Root of the filter thread.", { labels: { cf: ctx.runId } });
    const r1 = await reply(maya, root.thread.id, `Maya mentions the owner: ${word.toUpperCase()}.`, { mentions: [ownerId] });
    const r2 = await reply(owner, root.thread.id, "The owner follows up.");
    return { boardId, threadId: root.thread.id, rootId: root.message.id, r1: r1.message.id, r2: r2.message.id, word };
  });
}

async function handleOf(s: McpSession, boardId: string, principalId: string): Promise<string> {
  const { members } = await s.ok("list_members", { board_id: boardId });
  const m = members.find((x) => x.principal.id === principalId);
  if (!m) throw new Failure(`list_members does not list ${principalId}`);
  return m.handle;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T | undefined> {
  return until(fn, ms, 300);
}

export const filterCases: CaseDef[] = [
  {
    id: "core.read-messages",
    profile: "core",
    title: "read_messages filters by author, mentions, labels, text, source and thread, oldest first, and pages with after and before",
    async run(ctx) {
      const f = await filterThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const ownerId = (await ctx.me("owner")).id;
      const read = (s: McpSession, args: Record<string, unknown>) => s.ok("read_messages", { board_id: f.boardId, ...args } as never) as Promise<ToolOutput<"read_messages">>;
      const thread = [f.rootId, f.r1, f.r2];

      const all = await read(owner, { re: f.threadId });
      sameIds(ids(all), thread, "re (thread ID): the thread's messages, oldest first (05 §read_messages)");
      check(typeof all.cursor === "string" && all.cursor.length > 0 && all.has_more === false, "read_messages returns cursor and has_more");
      sameIds(ids(await read(owner, { re: f.r1 })), thread, "re takes any message ID in the thread");
      const mayaHandle = await handleOf(owner, f.boardId, mayaId);
      sameIds(ids(await read(owner, { re: f.threadId, by: mayaHandle })), [f.r1], "by: a member handle");
      sameIds(ids(await read(owner, { re: f.threadId, by: `@${mayaHandle}` })), [f.r1], "by: a handle with @");
      sameIds(ids(await read(owner, { re: f.threadId, by: mayaId })), [f.r1], "by: a principal ID");
      sameIds(ids(await read(owner, { re: f.threadId, by: "me" })), [f.rootId, f.r2], "by: me");
      sameIds(ids(await read(owner, { re: f.threadId, mentions: "me" })), [f.r1], "mentions: me");
      sameIds(ids(await read(maya, { re: f.threadId, mentions: await handleOf(maya, f.boardId, ownerId) })), [f.r1], "mentions: a handle");
      sameIds(ids(await read(owner, { labels: { cf: ctx.runId } })), thread, "labels: thread labels");
      sameIds(ids(await read(owner, { labels: { cf: `none|${ctx.runId}` } })), thread, "labels: a|b matches either value");
      sameIds(ids(await read(owner, { labels: { cf: `none-${ctx.runId}` } })), [], "labels: no match");
      sameIds(ids(await read(owner, { text: f.word.toLowerCase() })), [f.r1], "text: case-insensitive substring");
      sameIds(ids(await read(owner, { re: f.threadId, source: "board" })), thread, "source: board");
      sameIds(ids(await read(owner, { re: f.threadId, source: "slack" })), [], "source: slack (nothing synced)");
      sameIds(ids(await read(owner, { re: f.threadId, by: mayaHandle, text: f.word })), [f.r1], "filters combine");

      const page = await read(owner, { re: f.threadId, after: f.rootId, limit: 1 });
      sameIds(ids(page), [f.r1], "after a message ID, limit 1");
      check(page.has_more === true, "has_more is true when newer matching messages exist");
      sameIds(ids(await read(owner, { re: f.threadId, after: page.cursor })), [f.r2], "the page cursor follows on from the last returned message");
      sameIds(ids(await read(owner, { re: f.threadId, after: f.threadId })), [f.r1, f.r2], "after a thread ID: after its root message");
      sameIds(ids(await read(owner, { re: f.threadId, before: f.r2 })), [f.rootId, f.r1], "before a message ID");
      sameIds(ids(await read(owner, { re: f.threadId, limit: 2 })), [f.r1, f.r2], "without after: the latest, oldest first");

      await owner.fails("read_messages", { board_id: f.boardId, by: `nobody-${ctx.runId}` }, "invalid_argument");
      await owner.fails("read_messages", { board_id: f.boardId, labels: { "Bad Key": "x" } }, "invalid_argument");
      await owner.fails("read_messages", { board_id: f.boardId, after: "not-a-cursor" }, "invalid_argument");
      await owner.fails("read_messages", { board_id: f.boardId, after: f.rootId, before: f.r2 }, "invalid_argument");
      await owner.fails("read_messages", { board_id: f.boardId, limit: 501 }, "invalid_argument");
      if (await ctx.isMember("outsider", f.boardId)) ctx.note("outsider is a member of the owner's board; skipped the non-member check");
      else {
        const outsider = await ctx.session("outsider");
        await outsider.fails("read_messages", { board_id: f.boardId, by: mayaHandle }, "not_found");
        await outsider.fails("wait_for_activity", { re: f.rootId, after: f.rootId, timeout_seconds: 1 }, "not_found");
      }
    },
  },
  {
    id: "core.changes-filters",
    profile: "core",
    title: "get_changes takes the same filters and after; non-matching changes move the cursor on",
    async run(ctx) {
      const f = await filterThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const start = await boardCursor(owner, f.boardId);
      const theirs = await reply(maya, f.threadId, "A change by maya.");
      await reply(owner, f.threadId, "A change by the owner.");
      const changes: Change[] = [];
      let cursor = start;
      for (let i = 0; i < 50; i++) {
        const p = boardPage(await owner.ok("get_changes", { board_id: f.boardId, cursor, by: mayaId }), "get_changes with by");
        changes.push(...p.changes);
        check(p.cursor !== undefined, "filtered pages carry a cursor");
        cursor = p.cursor;
        if (!p.has_more) break;
      }
      sameIds(
        changes.map((c) => c.message_id ?? ""),
        [theirs.message.id],
        "get_changes with by returns only maya's change (05 §Filters)",
      );
      const ownerId = (await ctx.me("owner")).id;
      const after = boardPage(await owner.ok("get_changes", { board_id: f.boardId, after: f.rootId, re: f.threadId, by: "me" }), "get_changes after");
      check(after.changes.length > 0 && after.changes.every((c) => c.message?.author.id === ownerId && c.thread_id === f.threadId), "after + filters returns only matching changes");
      check(after.changes.some((c) => c.message_id === f.r2) && !after.changes.some((c) => c.message_id === f.rootId), "after a message starts after that message");
      const unfiltered = await readAll(owner, f.boardId, start);
      check(unfiltered.changes.length >= 2, "without filters, every change is returned");
      await owner.fails("get_changes", { inbox: true, by: "me" }, "invalid_argument");
      await owner.fails("get_changes", { board_id: f.boardId, cursor: start, after: f.rootId }, "invalid_argument");
    },
  },
  {
    id: "core.wait-after-message",
    profile: "core",
    title: "wait_for_activity after a message returns an answer that already exists; a filtered wait skips other changes",
    timeoutMs: 90_000,
    async run(ctx) {
      const boardId = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      await owner.reserveWrites(4);
      const q = await startThread(owner, boardId, `Question ${ctx.runId}`, "Is the refresh endpoint safe to cache?");
      const a = await reply(maya, q.thread.id, "Yes, for sixty seconds.");
      const forms: [string, Record<string, unknown>][] = [
        ["re + after (board from the message)", { re: q.message.id, after: q.message.id }],
        ["thread_id + after", { thread_id: q.thread.id, after: q.message.id }],
        ["board_id + after + by", { board_id: boardId, after: q.message.id, by: mayaId }],
      ];
      for (const [what, args] of forms) {
        const t0 = Date.now();
        const page = boardPage(await owner.ok("wait_for_activity", { ...args, timeout_seconds: 20 } as never), `wait_for_activity ${what}`);
        check(Date.now() - t0 < 5000, `wait_for_activity ${what}: an answer that already exists must return at once (05 §wait_for_activity)`);
        check(page.changes.some((c) => c.message_id === a.message.id), `wait_for_activity ${what}: the answer is in the result`);
        check(!page.changes.some((c) => c.message_id === q.message.id), `wait_for_activity ${what}: the message waited after is not in the result`);
      }

      const cursor = await boardCursor(owner, boardId);
      const waiting = owner.ok("wait_for_activity", { board_id: boardId, cursor, by: mayaId, timeout_seconds: 20 });
      await sleep(1000);
      const mine = await reply(owner, q.thread.id, "Not by maya: this must not end the wait.");
      await sleep(1000);
      const hers = await reply(maya, q.thread.id, "By maya: this ends the wait.");
      const woke = boardPage(await waiting, "filtered wait");
      check(woke.changes.some((c) => c.message_id === hers.message.id), "the filtered wait returned maya's message");
      check(!woke.changes.some((c) => c.message_id === mine.message.id), "the filtered wait did not return the owner's message");
      check(woke.changes.every((c) => c.message?.author.id === mayaId), "every returned change matches the filter");
      const quiet = boardPage(await owner.ok("wait_for_activity", { board_id: boardId, cursor: woke.cursor, text: `never-${ctx.runId}`, timeout_seconds: 2 }), "quiet filtered wait");
      check(quiet.changes.length === 0 && quiet.has_more === false, "a filtered wait with no match returns an empty page at the timeout");
      await owner.fails("wait_for_activity", { inbox: true, cursor: "x", by: "me" }, "invalid_argument");
    },
  },
];

/** Polls read_messages until `count` messages contain `text`; returns them. */
async function postsWith(s: McpSession, boardId: string, text: string, count: number, ms: number): Promise<Message[]> {
  let last: Message[] = [];
  await waitFor(async () => {
    last = (await s.ok("read_messages", { board_id: boardId, text })).messages;
    return last.length >= count;
  }, ms);
  return last;
}

export const automationCases: CaseDef[] = [
  {
    id: "automation.schedule-once",
    profile: "automation",
    title: "A scheduled reply posts once, as its creator, then the schedule is done",
    timeoutMs: 60_000,
    async run(ctx) {
      const f = await filterThread(ctx);
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const text = `Scheduled once ${ctx.runId}`;
      const { schedule } = await maya.ok("schedule_post", { thread_id: f.threadId, body: text, in_seconds: 2 });
      check(schedule.state === "pending" && schedule.thread_id === f.threadId && schedule.next_run_at, "schedule_post returns a pending schedule with next_run_at (11)");
      const listed = await maya.ok("list_schedules", { thread_id: f.threadId });
      check(listed.schedules.some((s) => s.id === schedule.id), "list_schedules lists the pending schedule");
      const posted = await postsWith(maya, f.boardId, text, 1, 30_000);
      check(posted.length === 1, `the scheduled post did not appear within 30 s (found ${posted.length})`);
      check(posted[0]!.author.id === mayaId && posted[0]!.thread_id === f.threadId, "the scheduled reply is in the thread, authored by its creator");
      await sleep(3000);
      check((await postsWith(maya, f.boardId, text, 2, 0)).length === 1, "a one-time schedule posts exactly once");
      const after = (await maya.ok("list_schedules", { thread_id: f.threadId, all: true })).schedules.find((s) => s.id === schedule.id);
      check(after?.state === "done" && after.runs === 1 && after.last_message_id === posted[0]!.id, `after its run the schedule is done with runs 1 and last_message_id (got ${JSON.stringify(after && { state: after.state, runs: after.runs })})`);
      check(!(await maya.ok("list_schedules", { thread_id: f.threadId })).schedules.some((s) => s.id === schedule.id), "without all, list_schedules lists only pending schedules");
    },
  },
  {
    id: "automation.schedule-repeat",
    profile: "automation",
    title: "A repeating schedule posts every interval, at least schedule_min_repeat_seconds apart, and stops after times",
    timeoutMs: 120_000,
    async run(ctx) {
      const min = (await ctx.limitsOf("owner")).schedule_min_repeat_seconds;
      if (typeof min !== "number") throw new Failure("limits.schedule_min_repeat_seconds is missing (07)");
      if (min > 15) ctx.skip(`schedule_min_repeat_seconds is ${min}; run the server in test mode (or lower OMB_LIMIT_SCHEDULE_MIN_REPEAT_SECONDS) to watch a repeat`);
      const f = await filterThread(ctx);
      const owner = await ctx.session("owner");
      if (min > 1) await owner.fails("schedule_post", { board_id: f.boardId, title: "Too fast", body: "x", every_seconds: min - 1, in_seconds: 5 }, "invalid_argument");
      const text = `Repeating ${ctx.runId}`;
      const { schedule } = await owner.ok("schedule_post", { board_id: f.boardId, title: `Repeat ${ctx.runId}`, body: text, labels: { cf: `rep${ctx.runId}` }, in_seconds: 1, every_seconds: min, times: 2 });
      check(schedule.every_seconds === min && schedule.times === 2, "the schedule echoes every_seconds and times");
      const posts = await postsWith(owner, f.boardId, text, 2, (1 + 2 * min + 20) * 1000);
      check(posts.length === 2, `expected 2 runs within ${1 + 2 * min + 20} s, saw ${posts.length}`);
      const gap = Date.parse(posts[1]!.created_at) - Date.parse(posts[0]!.created_at);
      check(gap >= min * 1000 - 250, `runs were ${gap} ms apart; at least ${min} s expected`);
      check(new Set(posts.map((p) => p.thread_id)).size === 2, "each run of a board schedule starts a new thread");
      await sleep(min * 1000 + 3000);
      check((await postsWith(owner, f.boardId, text, 3, 0)).length === 2, "the schedule stops after times runs");
      const s = (await owner.ok("list_schedules", { board_id: f.boardId, all: true })).schedules.find((x) => x.id === schedule.id);
      check(s?.state === "done" && s.runs === 2, `after its last run the schedule is done (got ${s?.state}, runs ${s?.runs})`);
    },
  },
  {
    id: "automation.schedule-cancel",
    profile: "automation",
    title: "Cancelling stops a schedule; only its creator or the board owner may cancel; readers cannot schedule",
    timeoutMs: 60_000,
    async run(ctx) {
      const f = await filterThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const text = `Cancelled ${ctx.runId}`;
      const { schedule } = await maya.ok("schedule_post", { thread_id: f.threadId, body: text, in_seconds: 4 });
      if (await ctx.isMember("outsider", f.boardId)) ctx.note("outsider is a member of the owner's board; skipped the non-member check");
      else await (await ctx.session("outsider")).fails("cancel_schedule", { schedule_id: schedule.id }, "not_found");
      await quotaReaderOnOwnerBoard(ctx);
      const quota = await ctx.session("quota");
      await quota.fails("cancel_schedule", { schedule_id: schedule.id }, "forbidden");
      await quota.fails("schedule_post", { thread_id: f.threadId, body: "a reader's schedule", in_seconds: 60 }, "forbidden");
      const first = await owner.ok("cancel_schedule", { schedule_id: schedule.id });
      check(first.cancelled === true && first.schedule.state === "cancelled", "the board owner cancels a member's schedule");
      const again = await maya.ok("cancel_schedule", { schedule_id: schedule.id });
      check(again.cancelled === false, "cancelling twice returns cancelled: false");
      await sleep(6000);
      check((await postsWith(owner, f.boardId, text, 1, 0)).length === 0, "a cancelled schedule never posts");
      await maya.fails("schedule_post", { thread_id: f.threadId, title: "no titles on replies", body: "x", in_seconds: 60 }, "invalid_argument");
      await maya.fails("schedule_post", { thread_id: f.threadId, body: "x", at: "2020-01-01T00:00:00Z" }, "invalid_argument");
      await maya.fails("schedule_post", { board_id: f.boardId, thread_id: f.threadId, body: "x", in_seconds: 60 }, "invalid_argument");
    },
  },
  {
    id: "automation.watcher-delivery",
    profile: "automation",
    title: "A watcher gets a signed verification, then signed deliveries of matching changes only; only the owner manages it",
    timeoutMs: 60_000,
    async run(ctx) {
      const f = await filterThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const ep = (await ctx.receiver()).endpoint("echo");
      await maya.fails("create_watcher", { board_id: f.boardId, url: ep.url, secret: ep.secret }, "forbidden");
      const r = await owner.call("create_watcher", { board_id: f.boardId, url: ep.url, secret: ep.secret, filter: { thread: f.threadId, by: mayaId } });
      if (!r.ok) throw new Failure(`create_watcher failed: ${r.error.code}: ${r.error.message} (is the server in test mode, allowing http://127.0.0.1 callbacks?)`, r.error);
      const { watcher } = r.data;
      check(watcher.status === "active" && watcher.filter.by === mayaId && watcher.filter.thread === f.threadId, "create_watcher returns an active watcher with its filter");
      const verification = ep.deliveries.find((d) => d.body?.type === "verification");
      check(verification, "no verification challenge was sent before the watcher was created (11 §Watchers)");
      check(verification.signatureError === null, `the verification signature is invalid: ${verification.signatureError}`);

      const skip = await reply(owner, f.threadId, "Not by maya: no delivery.");
      const hit = await reply(maya, f.threadId, "By maya: delivered.");
      const d = await ep.waitFor((x) => (x.body?.change as Change | undefined)?.message_id === hit.message.id, 20_000);
      check(d, "no delivery for a matching change within 20 s");
      check(d.signatureError === null, `delivery signature: ${d.signatureError}`);
      check(d.body?.type === "change" && d.body.watcher_id === watcher.id, "the body is {type: change, watcher_id, change}");
      const change = d.body.change as Change;
      check(change.type === "message.created" && change.board_id === f.boardId, "the delivered change is the message.created change");
      check(d.headers["webhook-id"] === `${watcher.id}_${change.seq}`, `webhook-id is <watcher>_<seq>, got ${d.headers["webhook-id"]}`);
      check(d.headers["x-omb-watcher-id"] === watcher.id, "X-OMB-Watcher-Id carries the watcher ID");
      await sleep(1500);
      check(!ep.deliveries.some((x) => (x.body?.change as Change | undefined)?.message_id === skip.message.id), "a change that does not match the filter was delivered");

      const listed = await waitFor(async () => {
        const w = (await owner.ok("list_watchers", { board_id: f.boardId })).watchers.find((x) => x.id === watcher.id);
        return w?.recent_deliveries.some((x) => x.change_seq === change.seq && x.status === "delivered") ? w : undefined;
      }, 10_000);
      check(listed, "list_watchers shows the delivery as delivered");
      await maya.fails("list_watchers", { board_id: f.boardId }, "forbidden");
      await maya.fails("delete_watcher", { watcher_id: watcher.id }, "forbidden");
      const del = await owner.ok("delete_watcher", { watcher_id: watcher.id });
      check(del.deleted === true, "delete_watcher deletes");
      const late = await reply(maya, f.threadId, "After the watcher was deleted.");
      await sleep(2500);
      check(!ep.deliveries.some((x) => (x.body?.change as Change | undefined)?.message_id === late.message.id), "a deleted watcher kept delivering");
    },
  },
  {
    id: "automation.watcher-refused",
    profile: "automation",
    title: "create_watcher refuses private, metadata and non-HTTPS URLs, bad secrets, and endpoints that fail the challenge",
    async run(ctx) {
      const boardId = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
      for (const url of ["https://10.0.0.1/hooks/omb", "https://192.168.1.10/hooks/omb", "https://169.254.169.254/latest/meta-data/", "https://[fd00::1]/hooks/omb", "http://10.1.2.3/hooks/omb", "http://example.test/hooks/omb"]) {
        const e: ErrorBody = await owner.fails("create_watcher", { board_id: boardId, url, secret }, "invalid_argument");
        const reason = (e.details as { reason?: unknown } | undefined)?.reason;
        check(reason === "blocked_address" || reason === "invalid_url", `${url}: details.reason ${String(reason)}, expected blocked_address or invalid_url`);
      }
      const ep = (await ctx.receiver()).endpoint("echo");
      for (const bad of ["whsec_" + Buffer.alloc(8, 1).toString("base64"), "not-a-secret"]) {
        await owner.fails("create_watcher", { board_id: boardId, url: ep.url, secret: bad }, "invalid_argument");
      }
      const wrong = (await ctx.receiver()).endpoint("wrong-challenge");
      const e = await owner.fails("create_watcher", { board_id: boardId, url: wrong.url, secret: wrong.secret }, "invalid_argument");
      check((e.details as { reason?: unknown } | undefined)?.reason === "challenge_failed", "an endpoint that does not echo the challenge is refused with reason challenge_failed");
      check(wrong.deliveries.some((d) => d.body?.type === "verification"), "the server sent a verification challenge");
      const { watchers } = await owner.ok("list_watchers", { board_id: boardId });
      check(!watchers.some((w) => w.url === wrong.url), "no watcher was created for the failed endpoint");
    },
  },
];

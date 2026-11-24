import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createContext, type AppContext } from "../src/context.ts";
import { migrate, openDatabase } from "../src/db/index.ts";
import { actorFromPrincipal, getPrincipal } from "../src/domain/access.ts";
import { addAgentToBoard, createAgent, ensureOwnBoard, removeMember } from "../src/domain/boards.ts";
import { getChanges, waitForActivity } from "../src/domain/changes.ts";
import { reply, startThread } from "../src/domain/conversation.ts";
import { readMessages } from "../src/domain/filters.ts";
import { createInvite, redeemInvite } from "../src/domain/invites.ts";
import { cancelSchedule, listSchedules, runDueSchedules, schedulePost } from "../src/domain/schedules.ts";
import { getUsage } from "../src/domain/usage.ts";
import { WatcherWorker, createWatcher, deleteWatcher, listWatchers } from "../src/domain/watchers.ts";
import type { Actor } from "../src/domain/model.ts";
import { OmbError } from "../src/errors.ts";
import { freePort, human, key, makeCtx } from "./helpers.ts";

async function rejects(p: Promise<unknown> | (() => unknown), code: string, reason?: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(e instanceof OmbError, `expected OmbError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (reason) assert.equal(e.details?.reason, reason);
    return e;
  }
  assert.fail(`expected ${code}`);
}

/** A context whose clock the test moves by hand. */
async function clockCtx(start = Date.parse("2026-11-20T09:00:00.000Z")): Promise<{ ctx: AppContext; advance: (ms: number) => void }> {
  let now = start;
  const dir = mkdtempSync(join(tmpdir(), "omb-auto-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PUBLIC_URL: "http://omb.test", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email" }, { dbPath: ":memory:" });
  config.limits.schedule_min_repeat_seconds = 60;
  config.plans = { base: config.limits, openwork: config.plans.openwork };
  const db = openDatabase(":memory:");
  await migrate(db);
  return { ctx: createContext(config, db, () => new Date(now)), advance: (ms) => (now += ms) };
}

function setup(ctx: AppContext) {
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const maya = human(ctx, "maya@example.test", "Maya");
  redeemInvite(ctx, maya, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  return { owner, maya, board };
}

function agentOf(ctx: AppContext, person: Actor, boardId: string): Actor {
  const agent = createAgent(ctx, person, "helper");
  addAgentToBoard(ctx, person, boardId, agent.id, "contributor");
  return actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
}

const ids = (r: { messages: { id: string }[] }) => r.messages.map((m) => m.id);

test("read_messages: every filter, oldest first, with paging by message and cursor", async () => {
  const ctx = await makeCtx();
  const { owner, maya, board } = setup(ctx);
  const bot = agentOf(ctx, maya, board.id);
  const a = startThread(ctx, owner, board.id, { title: "Bugs", body: "Checkout times out", labels: { kind: "bug", state: "open" }, idempotency_key: key() });
  const b = reply(ctx, maya, a.thread.id, { body: "I see it too, Owner", mentions: [owner.id], idempotency_key: key() });
  const c = reply(ctx, bot, a.thread.id, { body: "Trace attached: ÉCHEC in step 3", idempotency_key: key() });
  const d = startThread(ctx, maya, board.id, { title: "Ideas", body: "Dark mode", labels: { kind: "idea" }, idempotency_key: key() });
  const e = startThread(ctx, owner, board.id, { title: "From Slack", body: "synced text", idempotency_key: key() }, {
    source: { platform: "slack", author_name: "ada", url: null, external_id: "C1/1.0" },
  });
  const all = [a.message.id, b.message.id, c.message.id, d.message.id, e.message.id];

  assert.deepEqual(ids(readMessages(ctx, owner, board.id, {})), all, "latest messages, oldest first");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { by: "maya" })), [b.message.id, c.message.id, d.message.id], "a person's handle covers their agents");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { by: bot.id })), [c.message.id], "an agent by its ID");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { by: "me" })), [a.message.id, e.message.id]);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { mentions: "me" })), [b.message.id]);
  assert.deepEqual(ids(readMessages(ctx, maya, board.id, { mentions: "@owner" })), [b.message.id], "a handle with @");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { kind: "bug" } })), [a.message.id, b.message.id, c.message.id], "thread labels");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { kind: "idea|bug", state: "open" } })), [a.message.id, b.message.id, c.message.id], "every key; a|b alternatives");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { text: "échec" })), [c.message.id], "case-insensitive, beyond ASCII");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { source: "slack" })), [e.message.id]);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { source: "board" })), all.slice(0, 4));
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { re: a.thread.id })), all.slice(0, 3));
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { re: c.message.id })), all.slice(0, 3), "re takes any message in the thread");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { by: "maya", re: a.thread.id, text: "trace" })), [c.message.id], "filters combine");

  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { limit: 2 })), all.slice(3), "without after: the latest");
  const firstPage = readMessages(ctx, owner, board.id, { after: a.message.id, limit: 2 });
  assert.deepEqual(ids(firstPage), [b.message.id, c.message.id]);
  assert.equal(firstPage.has_more, true);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { after: firstPage.cursor })), [d.message.id, e.message.id], "the cursor follows on from the last message");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { before: d.message.id, limit: 2 })), [b.message.id, c.message.id]);
  const now = readMessages(ctx, owner, board.id, {});
  const later = reply(ctx, maya, d.thread.id, { body: "+1", idempotency_key: key() });
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { after: now.cursor })), [later.message.id], "after a read's cursor: what is new since");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { after: d.thread.id })), [e.message.id, later.message.id], "after a thread ID: after its root");

  await rejects(() => readMessages(ctx, owner, board.id, { by: "nobody" }), "invalid_argument");
  await rejects(() => readMessages(ctx, owner, board.id, { labels: { "Bad Key": "x" } }), "invalid_argument");
  await rejects(() => readMessages(ctx, owner, board.id, { after: "not-a-cursor" }), "invalid_argument");
  const outsider = human(ctx, "x@elsewhere.test");
  await rejects(() => readMessages(ctx, outsider, board.id, { by: "maya" }), "not_found");
  const other = ensureOwnBoard(ctx, outsider, { create: true })!;
  const theirs = startThread(ctx, outsider, other.id, { title: "Mine", body: "private", idempotency_key: key() });
  await rejects(() => readMessages(ctx, owner, board.id, { re: theirs.thread.id }), "not_found");
});

test("get_changes and wait_for_activity take the same filters; wait after a message returns an existing answer", async () => {
  const ctx = await makeCtx();
  const { owner, maya, board } = setup(ctx);
  const start = getChanges(ctx, owner, { board_id: board.id }).cursor;
  const t = startThread(ctx, owner, board.id, { title: "Release", body: "Ship it?", idempotency_key: key() });
  const answer = reply(ctx, maya, t.thread.id, { body: "yes", idempotency_key: key() });
  reply(ctx, owner, t.thread.id, { body: "thanks", idempotency_key: key() });

  const byMaya = getChanges(ctx, owner, { board_id: board.id, cursor: start, by: "maya" });
  assert.ok("changes" in byMaya);
  assert.deepEqual(byMaya.changes.map((c) => c.message_id), [answer.message.id]);
  assert.equal(byMaya.has_more, false);
  const members = getChanges(ctx, owner, { board_id: board.id, cursor: start, types: undefined, after: undefined });
  assert.ok("changes" in members && members.changes.length === 3);
  await rejects(() => getChanges(ctx, owner, { inbox: true, by: "maya" }), "invalid_argument");
  await rejects(() => getChanges(ctx, owner, { board_id: board.id, cursor: start, after: t.message.id }), "invalid_argument");

  // post, then wait: an answer that already exists comes back at once.
  const begun = Date.now();
  const page = await waitForActivity(ctx, owner, { thread_id: t.thread.id, after: t.message.id, by: "maya", timeout_seconds: 5 });
  assert.ok(Date.now() - begun < 1000, "returned without waiting");
  assert.ok("changes" in page);
  assert.deepEqual(page.changes.map((c) => c.message_id), [answer.message.id]);

  // naming only the message: the board is the message's, and the answer is already there
  const inferred = await waitForActivity(ctx, owner, { re: t.message.id, after: t.message.id, by: "maya", timeout_seconds: 5 });
  assert.ok("changes" in inferred);
  assert.deepEqual(inferred.changes.map((c) => c.message_id), [answer.message.id]);
  const stranger = human(ctx, "stranger@elsewhere.test");
  await rejects(waitForActivity(ctx, stranger, { re: t.message.id, after: t.message.id, timeout_seconds: 1 }), "not_found");
  await rejects(waitForActivity(ctx, stranger, { re: "m_doesnotexist", timeout_seconds: 1 }), "not_found");

  // a filtered wait ignores non-matching changes and wakes on a matching one
  const cursor = getChanges(ctx, owner, { board_id: board.id }).cursor;
  const waiting = waitForActivity(ctx, owner, { board_id: board.id, cursor, mentions: "me", timeout_seconds: 5 });
  setTimeout(() => reply(ctx, maya, t.thread.id, { body: "not for you", idempotency_key: key() }), 50);
  setTimeout(() => reply(ctx, maya, t.thread.id, { body: "for you", mentions: [owner.id], idempotency_key: key() }), 200);
  const woke = await waiting;
  assert.ok("changes" in woke);
  assert.equal(woke.changes.length, 1);
  assert.equal(woke.changes[0]!.message?.body, "for you");

  // a timeout returns an empty page with a cursor at or after the input
  const quiet = await waitForActivity(ctx, owner, { board_id: board.id, cursor: woke.cursor, text: "never-posted", timeout_seconds: 1 });
  assert.ok("changes" in quiet && quiet.changes.length === 0 && quiet.has_more === false);

  // thread.updated matches through the thread's root message and current labels
  const labelCursor = getChanges(ctx, owner, { board_id: board.id }).cursor;
  const { setLabels } = await import("../src/domain/conversation.ts");
  setLabels(ctx, owner, t.thread.id, { set: { state: "done" } });
  const labelled = getChanges(ctx, owner, { board_id: board.id, cursor: labelCursor, labels: { state: "done" } });
  assert.ok("changes" in labelled);
  assert.deepEqual(labelled.changes.map((c) => c.type), ["thread.updated"]);
});

test("schedules: one run, repeats at least the minimum apart, cancel, limits, lost access, crash safety", async () => {
  const { ctx, advance } = await clockCtx();
  const { owner, maya, board } = setup(ctx);
  const t = startThread(ctx, owner, board.id, { title: "Standup", body: "Daily notes", idempotency_key: key() });
  const count = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  const before = count();

  const once = schedulePost(ctx, maya, { thread_id: t.thread.id, body: "still broken?", in_seconds: 3600 }).schedule;
  assert.equal(once.state, "pending");
  assert.equal(once.next_run_at, "2026-11-20T10:00:00.000Z");
  assert.equal(runDueSchedules(ctx), 0);
  advance(3600_000);
  assert.equal(runDueSchedules(ctx), 1);
  assert.equal(runDueSchedules(ctx), 0, "a run fires once");
  assert.equal(count(), before + 1);
  const done = listSchedules(ctx, maya, { thread_id: t.thread.id, all: true }).schedules[0]!;
  assert.equal(done.state, "done");
  assert.equal(done.runs, 1);
  const posted = ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(done.last_message_id) as { author_id: string; body: string };
  assert.equal(posted.author_id, maya.id, "posts as its creator");

  await rejects(() => schedulePost(ctx, maya, { thread_id: t.thread.id, body: "x", in_seconds: 10, every_seconds: 30 }), "invalid_argument");
  await rejects(() => schedulePost(ctx, maya, { board_id: board.id, body: "no title", in_seconds: 10 }), "invalid_argument");
  await rejects(() => schedulePost(ctx, maya, { thread_id: t.thread.id, body: "x", at: "2026-01-01T00:00:00Z" }), "invalid_argument");

  const repeat = schedulePost(ctx, owner, { board_id: board.id, title: "Weekly", body: "standup", labels: { kind: "standup" }, every_seconds: 60, times: 3 }).schedule;
  advance(60_000);
  runDueSchedules(ctx);
  advance(60_000);
  runDueSchedules(ctx);
  // the server was down for ten minutes: one catch-up run, not ten
  advance(600_000);
  runDueSchedules(ctx);
  advance(600_000);
  runDueSchedules(ctx);
  const weekly = ctx.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE title = 'Weekly'").get() as { n: number };
  assert.equal(weekly.n, 3, "three runs in all");
  assert.equal(listSchedules(ctx, owner, { board_id: board.id, all: true }).schedules.find((s) => s.id === repeat.id)!.state, "done");
  assert.deepEqual(readMessages(ctx, owner, board.id, { labels: { kind: "standup" } }).messages.length, 3);

  const cancelled = schedulePost(ctx, maya, { thread_id: t.thread.id, body: "nag", every_seconds: 60 }).schedule;
  await rejects(() => cancelSchedule(ctx, human(ctx, "x@elsewhere.test"), cancelled.id), "not_found");
  assert.equal(cancelSchedule(ctx, owner, cancelled.id).cancelled, true, "the board owner can cancel");
  assert.equal(cancelSchedule(ctx, maya, cancelled.id).cancelled, false);
  const n = count();
  advance(120_000);
  runDueSchedules(ctx);
  assert.equal(count(), n, "a cancelled schedule never runs");

  // crash safety: a run that posted but was not recorded posts nothing the second time
  const crash = schedulePost(ctx, owner, { thread_id: t.thread.id, body: "exactly once", in_seconds: 60 }).schedule;
  advance(60_000);
  reply(ctx, owner, t.thread.id, { body: "exactly once", idempotency_key: `sch:${crash.id}:1` });
  const afterCrash = count();
  runDueSchedules(ctx);
  assert.equal(count(), afterCrash, "the run's idempotency key replays the earlier post");
  assert.equal(listSchedules(ctx, owner, { thread_id: t.thread.id, all: true }).schedules.find((s) => s.id === crash.id)!.state, "done");

  // a creator who loses access stops their schedules
  const lost = schedulePost(ctx, maya, { thread_id: t.thread.id, body: "will not post", in_seconds: 60 }).schedule;
  removeMember(ctx, owner, board.id, maya.id);
  advance(60_000);
  runDueSchedules(ctx);
  const stopped = listSchedules(ctx, owner, { thread_id: t.thread.id, all: true }).schedules.find((s) => s.id === lost.id)!;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stopped_reason, "access_ended");

  // a disabled creator stops too
  const parked = schedulePost(ctx, owner, { thread_id: t.thread.id, body: "parked", in_seconds: 60 }).schedule;
  ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.id);
  advance(60_000);
  runDueSchedules(ctx);
  ctx.db.prepare("UPDATE principals SET disabled_at = NULL WHERE id = ?").run(owner.id);
  assert.equal(listSchedules(ctx, owner, { thread_id: t.thread.id, all: true }).schedules.find((s) => s.id === parked.id)!.stopped_reason, "principal_disabled");

  // pending limit
  ctx.config.limits.pending_schedules_per_board = 1;
  schedulePost(ctx, owner, { thread_id: t.thread.id, body: "one", in_seconds: 60 });
  const over = await rejects(() => schedulePost(ctx, owner, { thread_id: t.thread.id, body: "two", in_seconds: 60 }), "quota_exceeded");
  assert.equal(over.details?.allowance, "pending_schedules");
  assert.equal(getUsage(ctx, owner, board.id).allowances.find((x) => x.allowance === "pending_schedules")!.used, 1);
});

interface Received {
  headers: Record<string, string>;
  raw: string;
  body: Record<string, unknown>;
}

async function receiver(mode: { status?: number; echo?: boolean } = {}): Promise<{ url: string; got: Received[]; server: Server; secret: string }> {
  const got: Received[] = [];
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      got.push({ headers: req.headers as Record<string, string>, raw, body });
      if (body.type === "verification") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: mode.echo === false ? "nope" : body.challenge }));
        return;
      }
      res.writeHead(mode.status ?? 204).end();
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${port}/hook`, got, server, secret };
}

function verify(secret: string, r: Received): boolean {
  const k = Buffer.from(secret.slice(6), "base64");
  const expected = createHmac("sha256", k).update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.raw}`).digest("base64");
  return r.headers["webhook-signature"] === `v1,${expected}`;
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("watchers: verified handshake, signed filtered deliveries, private addresses refused, owner only, stop on lost ownership", async (t) => {
  const ctx = await makeCtx();
  const { owner, maya, board } = setup(ctx);
  const ok = await receiver();
  const bad = await receiver({ echo: false });
  t.after(() => {
    ok.server.close();
    bad.server.close();
  });
  const worker = new WatcherWorker(ctx);
  const stopWorker = worker.start();
  t.after(stopWorker);

  await rejects(createWatcher(ctx, maya, board.id, { url: ok.url, secret: ok.secret }), "forbidden");
  await rejects(createWatcher(ctx, owner, board.id, { url: "https://10.0.0.1/hook", secret: ok.secret }), "invalid_argument", "blocked_address");
  await rejects(createWatcher(ctx, owner, board.id, { url: "https://169.254.169.254/latest", secret: ok.secret }), "invalid_argument", "blocked_address");
  await rejects(createWatcher(ctx, owner, board.id, { url: "http://example.test/hook", secret: ok.secret }), "invalid_argument", "invalid_url");
  await rejects(createWatcher(ctx, owner, board.id, { url: ok.url, secret: "whsec_short" }), "invalid_argument", "invalid_secret");
  await rejects(createWatcher(ctx, owner, board.id, { url: bad.url, secret: bad.secret }), "invalid_argument", "challenge_failed");

  const { watcher } = await createWatcher(ctx, owner, board.id, { url: ok.url, secret: ok.secret, filter: { by: "maya", types: ["message.created", "thread.created"] } });
  assert.equal(watcher.filter.by, maya.id, "handles are stored as principal IDs");
  const challenge = ok.got.find((g) => g.body.type === "verification");
  assert.ok(challenge && verify(ok.secret, challenge), "a signed verification challenge came first");

  const th = startThread(ctx, owner, board.id, { title: "Ops", body: "owner post", idempotency_key: key() });
  const mine = reply(ctx, maya, th.thread.id, { body: "maya reply", idempotency_key: key() });
  await until(() => ok.got.some((g) => g.body.type === "change"));
  await new Promise((r) => setTimeout(r, 200));
  const changes = ok.got.filter((g) => g.body.type === "change");
  assert.equal(changes.length, 1, "only the matching change");
  const d = changes[0]!;
  assert.ok(verify(ok.secret, d), "Standard Webhooks signature");
  assert.equal(d.body.watcher_id, watcher.id);
  assert.equal(d.headers["x-omb-watcher-id"], watcher.id);
  assert.equal((d.body.change as { message_id: string }).message_id, mine.message.id);
  assert.equal(d.headers["webhook-id"], `${watcher.id}_${(d.body.change as { seq: number }).seq}`);

  const listed = listWatchers(ctx, owner, board.id).watchers[0]!;
  await until(() => listWatchers(ctx, owner, board.id).watchers[0]!.recent_deliveries[0]?.status === "delivered");
  assert.equal(listed.status, "active");
  assert.throws(() => listWatchers(ctx, maya, board.id), /owner/);

  // limit
  ctx.config.limits.watchers_per_board = 1;
  const over = await rejects(createWatcher(ctx, owner, board.id, { url: ok.url, secret: ok.secret }), "quota_exceeded");
  assert.equal(over.details?.allowance, "watchers");

  // a watcher stops when its owner no longer owns the board
  const other = human(ctx, "new-owner@example.test");
  ctx.db.prepare("UPDATE boards SET owner_id = ? WHERE id = ?").run(other.id, board.id);
  reply(ctx, maya, th.thread.id, { body: "after the handover", idempotency_key: key() });
  await until(() => (ctx.db.prepare("SELECT status FROM watchers WHERE id = ?").get(watcher.id) as { status: string }).status === "stopped");
  assert.equal((ctx.db.prepare("SELECT stopped_reason FROM watchers WHERE id = ?").get(watcher.id) as { stopped_reason: string }).stopped_reason, "ownership_ended");
  ctx.db.prepare("UPDATE boards SET owner_id = ? WHERE id = ?").run(owner.id, board.id);
  assert.equal(deleteWatcher(ctx, owner, watcher.id).deleted, true);
  assert.equal(listWatchers(ctx, owner, board.id).watchers.length, 0);
});

test("watchers: failed deliveries are retried with backoff from the durable queue", async (t) => {
  const ctx = await makeCtx();
  const { owner, board } = setup(ctx);
  const flaky = await receiver({ status: 503 });
  t.after(() => flaky.server.close());
  const { watcher } = await createWatcher(ctx, owner, board.id, { url: flaky.url, secret: flaky.secret });
  const worker = new WatcherWorker(ctx);
  startThread(ctx, owner, board.id, { title: "Retry me", body: "please", idempotency_key: key() });
  await worker.tick();
  const row = () => ctx.db.prepare("SELECT status, attempts, last_error, next_attempt_at FROM watcher_deliveries WHERE watcher_id = ? AND change_type = 'thread.created'").get(watcher.id) as {
    status: string;
    attempts: number;
    last_error: string;
    next_attempt_at: string;
  };
  assert.equal(row().status, "pending");
  assert.equal(row().attempts, 1);
  assert.equal(row().last_error, "HTTP 503");
  assert.ok(row().next_attempt_at > new Date().toISOString(), "the next attempt waits");
  // a new worker (after a restart) picks the pending delivery up from the database
  ctx.db.prepare("UPDATE watcher_deliveries SET next_attempt_at = ?").run(new Date(0).toISOString());
  await new WatcherWorker(ctx).tick();
  assert.equal(row().attempts, 2);
});

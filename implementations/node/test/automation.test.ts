import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createContext, type AppContext } from "@openmessageboard/core/context";
import { migrate, openDatabase } from "../src/db/index.ts";
import { actorFromPrincipal, getPrincipal } from "@openmessageboard/core/domain/access";
import { addAgentToBoard, createAgent, ensureOwnBoard, removeMember } from "@openmessageboard/core/domain/boards";
import { getChanges, waitForActivity } from "@openmessageboard/core/domain/changes";
import { reply, startThread } from "@openmessageboard/core/domain/conversation";
import { readMessages } from "@openmessageboard/core/domain/filters";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { cancelSchedule, listSchedules, runDueSchedules, schedulePost } from "@openmessageboard/core/domain/schedules";
import { getUsage } from "@openmessageboard/core/domain/usage";
import { WatcherWorker, createWatcher, deleteWatcher, listWatchers } from "@openmessageboard/core/domain/watchers";
import type { Actor } from "@openmessageboard/core/domain/model";
import { OmbError } from "@openmessageboard/core/errors";
import { ensureProfile, profileActor } from "@openmessageboard/core/domain/profiles";
import { freePort, human, key, makeCtx } from "./helpers.ts";
import { nodePlatform } from "../src/platform.ts";

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
  config.plans = { base: config.limits, plus: config.plans.plus };
  const db = openDatabase(":memory:");
  await migrate(db);
  return { ctx: createContext(config, db, () => new Date(now), nodePlatform(config.dataDir)), advance: (ms) => (now += ms) };
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

  // profiles: a person's handle covers them; a profile handle names just the profile
  const fx = profileActor(maya, ensureProfile(ctx, getPrincipal(ctx, maya.id)!, "fx"));
  const fromFx = reply(ctx, fx, a.thread.id, { body: "fx checking in", idempotency_key: key() });
  const mayaHandle = (ctx.db.prepare("SELECT handle FROM memberships WHERE board_id = ? AND principal_id = ?").get(board.id, maya.id) as { handle: string }).handle;
  assert.ok(ids(readMessages(ctx, owner, board.id, { by: "maya" })).includes(fromFx.message.id), "a person's handle covers their profiles");
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { by: `${mayaHandle}/fx` })), [fromFx.message.id], "a profile handle");
  assert.deepEqual(ids(readMessages(ctx, fx, board.id, { by: "me" })), [fromFx.message.id], "me as a profile is just the profile");

  // a message's own labels match too (label filters cover the message or its thread's root)
  const { labelMessage } = await import("@openmessageboard/core/domain/messages");
  labelMessage(ctx, owner, b.message.id, { set: { triage: "yes" } });
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { triage: "yes" } })), [b.message.id]);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { kind: "bug", triage: "yes" } })), [b.message.id], "one key on the root, one on the message");

  // board.task in a label filter matches the task state, as in list_threads
  const task = startThread(ctx, owner, board.id, { title: "Ship 1.4", body: "a task", task: true, idempotency_key: key() });
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { "board.task": "open" } })), [task.message.id]);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { "board.task": "completed|ready" } })), [task.message.id]);
  assert.deepEqual(ids(readMessages(ctx, owner, board.id, { labels: { "board.task": "completed" } })), []);
  await rejects(() => readMessages(ctx, owner, board.id, { labels: { "board.task": "sleeping" } }), "invalid_argument");

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
  const { setLabels } = await import("@openmessageboard/core/domain/conversation");
  setLabels(ctx, owner, t.thread.id, { set: { state: "done" } });
  const labelled = getChanges(ctx, owner, { board_id: board.id, cursor: labelCursor, labels: { state: "done" } });
  assert.ok("changes" in labelled);
  assert.deepEqual(labelled.changes.map((c) => c.type), ["labels.changed", "thread.updated"]);
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

  // a scoped token's schedules end before the token does
  const scoped: Actor = { ...owner, scope: { boards: null, can: ["read", "post", "react", "label"], profile: null, expires_at: new Date(Date.parse("2026-11-20T09:00:00Z") + 7_200_000 + 3_600_000).toISOString() } };
  await rejects(() => schedulePost(ctx, scoped, { thread_id: t.thread.id, body: "forever", every_seconds: 60 }), "invalid_argument");
  await rejects(() => schedulePost(ctx, scoped, { thread_id: t.thread.id, body: "too late", in_seconds: 86_400 }), "invalid_argument");
  const bounded = schedulePost(ctx, scoped, { thread_id: t.thread.id, body: "bounded", every_seconds: 60, times: 3 }).schedule;
  cancelSchedule(ctx, owner, bounded.id);

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

/** `mode` is read on every request, so a test can change how the endpoint answers while it runs. */
async function receiver(mode: { status?: number; echo?: boolean; verifyStatus?: number } = {}): Promise<{ url: string; got: Received[]; server: Server; secret: string }> {
  const got: Received[] = [];
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      got.push({ headers: req.headers as Record<string, string>, raw, body });
      if (body.type === "verification") {
        res.writeHead(mode.verifyStatus ?? 200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: mode.echo === false ? "nope" : body.challenge }));
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

test("watchers: verified again after a day, wait while the endpoint is down, and stop when it no longer echoes", async (t) => {
  const { ctx, advance } = await clockCtx();
  const { owner, board } = setup(ctx);
  const mode: { echo?: boolean; verifyStatus?: number } = {};
  const hook = await receiver(mode);
  t.after(() => hook.server.close());
  const { watcher } = await createWatcher(ctx, owner, board.id, { url: hook.url, secret: hook.secret });
  const worker = new WatcherWorker(ctx);
  const challenges = () => hook.got.filter((g) => g.body.type === "verification").length;
  const changes = () => hook.got.filter((g) => g.body.type === "change").length;
  const delivery = (seq: number) =>
    ctx.db.prepare("SELECT status, attempts, last_error FROM watcher_deliveries WHERE watcher_id = ? AND change_seq = ?").get(watcher.id, seq) as { status: string; attempts: number; last_error: string | null };
  const watcherRow = () => ctx.db.prepare("SELECT status, stopped_reason FROM watchers WHERE id = ?").get(watcher.id) as { status: string; stopped_reason: string | null };
  const dueNow = () => ctx.db.prepare("UPDATE watcher_deliveries SET next_attempt_at = ? WHERE status = 'pending'").run(new Date(0).toISOString());
  const seqOf = (title: string) => (ctx.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s + (startThread(ctx, owner, board.id, { title, body: "x", idempotency_key: key() }), 1);

  // Within a day of the last success nothing is asked again.
  seqOf("First");
  await worker.tick();
  assert.equal(challenges(), 1, "only the challenge from creation");
  assert.equal(changes(), 1);

  // More than a day later the endpoint is challenged before anything is sent.
  advance(25 * 3_600_000);
  seqOf("Second");
  await worker.tick();
  assert.equal(challenges(), 2, "a second challenge after 24 hours without a success");
  assert.equal(changes(), 2);
  const order = hook.got.map((g) => g.body.type);
  assert.ok(order.lastIndexOf("verification") < order.lastIndexOf("change"), "the challenge came before the delivery");

  // An endpoint that cannot be reached is tried again; nothing is sent meanwhile and the watcher keeps running.
  advance(25 * 3_600_000);
  mode.verifyStatus = 503;
  const third = seqOf("Third");
  await worker.tick();
  assert.equal(changes(), 2, "no content goes to an endpoint that has not answered its challenge");
  assert.deepEqual(delivery(third), { status: "pending", attempts: 1, last_error: "unverified" });
  assert.equal(watcherRow().status, "active");
  mode.verifyStatus = 200;
  dueNow();
  await worker.tick();
  assert.equal(changes(), 3);
  assert.equal(delivery(third).status, "delivered");

  // An endpoint that answers without the challenge is no longer the endpoint that was verified: the watcher stops,
  // its queue is dropped, and it is told nothing more.
  advance(25 * 3_600_000);
  mode.echo = false;
  const fourth = seqOf("Fourth");
  await worker.tick();
  assert.deepEqual(watcherRow(), { status: "stopped", stopped_reason: "verification_failed" });
  assert.equal(delivery(fourth).status, "failed");
  await worker.tick();
  assert.equal(changes(), 3);
  assert.ok(!hook.got.some((g) => g.body.type === "terminated"), "no last envelope after a failed verification");
});

test("watchers: a stopped watcher sends one signed terminated envelope, except after a 410", async (t) => {
  const ctx = await makeCtx();
  const { owner, maya, board } = setup(ctx);
  const hook = await receiver();
  const gone = await receiver({ status: 410 });
  t.after(() => {
    hook.server.close();
    gone.server.close();
  });
  const { watcher } = await createWatcher(ctx, owner, board.id, { url: hook.url, secret: hook.secret });
  const second = await createWatcher(ctx, owner, board.id, { url: gone.url, secret: gone.secret });
  const worker = new WatcherWorker(ctx);
  startThread(ctx, owner, board.id, { title: "Before", body: "x", idempotency_key: key() });
  await worker.tick();
  // The receiver that answered 410 asked for the stop itself: no envelope for it.
  assert.equal((ctx.db.prepare("SELECT stopped_reason FROM watchers WHERE id = ?").get(second.watcher.id) as { stopped_reason: string }).stopped_reason, "gone");

  const other = human(ctx, "new-owner@example.test");
  ctx.db.prepare("UPDATE boards SET owner_id = ? WHERE id = ?").run(other.id, board.id);
  startThread(ctx, maya, board.id, { title: "After the handover", body: "not for the old owner's watcher", idempotency_key: key() });
  await worker.tick();
  await worker.tick();
  const last = hook.got.filter((g) => g.body.type === "terminated");
  assert.equal(last.length, 1, "exactly one terminated envelope");
  assert.deepEqual(last[0]!.body, { type: "terminated", watcher_id: watcher.id, reason: "ownership_ended" });
  assert.ok(verify(hook.secret, last[0]!), "the last envelope is signed");
  assert.equal(last[0]!.headers["x-omb-watcher-id"], watcher.id);
  assert.match(last[0]!.headers["webhook-id"]!, /^msg_terminated_[A-Za-z0-9_-]+$/);
  assert.ok(!hook.got.some((g) => g.body.type === "change" && (g.body.change as { thread?: { title?: string } }).thread?.title === "After the handover"), "nothing after the handover is delivered");
  assert.equal(hook.got.at(-1)!.body.type, "terminated", "nothing follows the last envelope");
  await worker.tick();
  assert.equal(gone.got.filter((g) => g.body.type === "terminated").length, 0);
  // The envelope is not one of the watcher's change deliveries.
  ctx.db.prepare("UPDATE boards SET owner_id = ? WHERE id = ?").run(owner.id, board.id);
  const listed = listWatchers(ctx, owner, board.id).watchers.find((w) => w.id === watcher.id)!;
  assert.equal(listed.stopped_reason, "ownership_ended");
  assert.ok(listed.recent_deliveries.every((d) => d.change_seq > 0));
});

test("channels: filters, waits, schedules and watchers follow channel access and take a channel filter", async (t) => {
  const { createChannel, createGrant } = await import("@openmessageboard/core/domain/channels");
  const ctx = await makeCtx();
  const { owner, maya, board } = setup(ctx);
  // A private channel only the owner can use.
  createChannel(ctx, owner, board.id, { path: "security", private: true });
  const secret = startThread(ctx, owner, board.id, { channel: "security", title: "Incident", body: "private detail", idempotency_key: key() });
  const dev = startThread(ctx, maya, board.id, { channel: "dev/web", title: "Web", body: "dev detail", idempotency_key: key() });
  const general = startThread(ctx, maya, board.id, { title: "Hello", body: "general detail", idempotency_key: key() });

  assert.ok(!ids(readMessages(ctx, maya, board.id, {})).includes(secret.message.id), "read_messages hides unreadable channels");
  assert.ok(!ids(readMessages(ctx, maya, board.id, { by: "owner" })).includes(secret.message.id), "also with filters");
  assert.ok(ids(readMessages(ctx, owner, board.id, { by: "me" })).includes(secret.message.id));
  assert.deepEqual(ids(readMessages(ctx, maya, board.id, { channel: "dev/" })), [dev.message.id], "a subtree filter");
  assert.deepEqual(ids(readMessages(ctx, maya, board.id, { channel: "general" })), [general.message.id]);
  await rejects(() => readMessages(ctx, maya, board.id, { re: secret.thread.id }), "not_found");
  await rejects(() => readMessages(ctx, maya, board.id, { after: secret.message.id }), "not_found");
  await rejects(() => readMessages(ctx, maya, board.id, { channel: "Not A Channel" }), "invalid_argument");
  const start = getChanges(ctx, maya, { board_id: board.id }).cursor;
  reply(ctx, owner, secret.thread.id, { body: "more private detail", idempotency_key: key() });
  reply(ctx, owner, dev.thread.id, { body: "dev reply", idempotency_key: key() });
  const filtered = getChanges(ctx, maya, { board_id: board.id, cursor: start, by: "owner" });
  assert.ok("changes" in filtered);
  assert.deepEqual(filtered.changes.map((c) => c.thread_id), [dev.thread.id], "filtered changes skip unreadable channels");
  const quiet = await waitForActivity(ctx, maya, { board_id: board.id, cursor: start, channel: "security", timeout_seconds: 1 });
  assert.ok("changes" in quiet && quiet.changes.length === 0, "a wait never returns changes from an unreadable channel");

  // schedules: a new thread takes a channel; posting needs post there, at creation and when it fires
  await rejects(() => schedulePost(ctx, maya, { board_id: board.id, channel: "security", title: "x", body: "x", in_seconds: 60 }), "forbidden");
  const s = schedulePost(ctx, maya, { board_id: board.id, channel: "dev/web", title: "Nightly", body: "nightly report", in_seconds: 1 }).schedule;
  assert.equal(s.channel, "dev/web");
  assert.equal(listSchedules(ctx, owner, { board_id: board.id, channel: "dev/" }).schedules.length, 1);
  assert.equal(listSchedules(ctx, owner, { board_id: board.id, channel: "security" }).schedules.length, 0);
  // the owner closes dev/ to everyone else before it fires
  createGrant(ctx, owner, board.id, { principals: [{ kind: "member", principal_id: maya.id }], can: { "dev/": ["read"] } });
  const late = new Date(Date.now() + 5000);
  const clock = createContext(ctx.config, ctx.db, () => late, ctx.platform);
  runDueSchedules(clock);
  const after = listSchedules(ctx, maya, { board_id: board.id, all: true }).schedules.find((x) => x.id === s.id)!;
  assert.equal(after.state, "stopped");
  assert.equal(after.stopped_reason, "cannot_post");
  const ownerSchedule = schedulePost(ctx, owner, { thread_id: secret.thread.id, body: "private reminder", in_seconds: 3600 }).schedule;
  assert.ok(!listSchedules(ctx, maya, { board_id: board.id }).schedules.some((x) => x.id === ownerSchedule.id), "schedules in unreadable channels are hidden");
  await rejects(() => cancelSchedule(ctx, maya, ownerSchedule.id), "not_found");

  // watchers: a channel filter, and deliveries follow the owner's access
  const hook = await receiver();
  t.after(() => hook.server.close());
  const worker = new WatcherWorker(ctx);
  const { watcher } = await createWatcher(ctx, owner, board.id, { url: hook.url, secret: hook.secret, filter: { channel: "dev/", types: ["message.created"] } });
  assert.equal(watcher.filter.channel, "dev/");
  reply(ctx, owner, general.thread.id, { body: "not in dev", idempotency_key: key() });
  const inDev = reply(ctx, owner, dev.thread.id, { body: "in dev", idempotency_key: key() });
  await worker.tick();
  const got = hook.got.filter((g) => g.body.type === "change").map((g) => (g.body.change as { message_id: string }).message_id);
  assert.deepEqual(got, [inDev.message.id]);
});

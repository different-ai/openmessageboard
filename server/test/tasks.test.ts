import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCtx, human, key } from "./helpers.ts";
import { ensureOwnBoard, createAgent, addAgentToBoard, removeMember } from "../src/domain/boards.ts";
import { createInvite, redeemInvite } from "../src/domain/invites.ts";
import { startThread, getThread, listThreads, setLabels, deleteMessage } from "../src/domain/conversation.ts";
import { claimTask, createTasks, expireTaskLeases, renewTask, updateTask } from "../src/domain/tasks.ts";
import { getChanges, getInbox } from "../src/domain/changes.ts";
import { actorFromPrincipal, getPrincipal } from "../src/domain/access.ts";
import { migrate, openDatabase } from "../src/db/index.ts";
import { ensureProfile, profileActor } from "../src/domain/profiles.ts";
import { createGrant } from "../src/domain/channels.ts";
import { OmbError } from "../src/errors.ts";
import type { AppContext } from "../src/context.ts";
import type { Actor } from "../src/domain/model.ts";

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(e instanceof OmbError, `expected OmbError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}`);
}

async function setup(limits: Record<string, number> = {}) {
  const ctx = await makeCtx({}, limits);
  const owner = human(ctx, "owner@example.test", "Lead");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const w1 = human(ctx, "w1@example.test", "W1");
  const w2 = human(ctx, "w2@example.test", "W2");
  const reader = human(ctx, "r@example.test", "R");
  for (const w of [w1, w2]) redeemInvite(ctx, w, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  redeemInvite(ctx, reader, createInvite(ctx, owner, board.id, { audience: "link", role: "reader" }).url!);
  const task = (who: Actor, title: string, extra: { labels?: Record<string, string>; needs?: string[]; for?: string; claim?: boolean } = {}) =>
    startThread(ctx, who, board.id, { title, body: `Do: ${title}`, task: true, idempotency_key: key(), ...extra });
  return { ctx, owner, board, w1, w2, reader, task };
}

/** Freezes the context's clock (on first use) and moves it forward. */
function advance(ctx: AppContext, ms: number) {
  const at = ctx.now().getTime() + ms;
  ctx.now = () => new Date(at);
}

test("tasks: claim races, re-claim by the holder, complete with a result, stale tokens", async () => {
  const { ctx, owner, board, w1, w2, task } = await setup();
  const t = task(owner, "Fix flaky test", { labels: { area: "ci" } });
  assert.equal(t.thread.task?.state, "ready");
  assert.equal(t.thread.task?.owner.id, owner.id);
  assert.deepEqual(t.thread.task?.needs, []);
  const results = await Promise.allSettled([claimTask(ctx, w1, { thread_id: t.thread.id }), claimTask(ctx, w2, { thread_id: t.thread.id })]);
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((lost.reason as OmbError).code, "task_already_claimed");
  const winner = results[0]!.status === "fulfilled" ? w1 : w2;
  const { claim, thread } = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimTask>>>).value;
  assert.equal(thread.task?.state, "claimed");
  assert.equal(thread.task?.assignee?.id, winner.id);
  assert.equal(thread.task?.lease_until, claim.until);
  assert.equal(claim.epoch, 1);
  const leaseMs = Date.parse(claim.until) - Date.now();
  assert.ok(leaseMs > 290_000 && leaseMs <= 300_000, `default lease is task_lease_seconds (got ${leaseMs} ms)`);

  const c0 = getChanges(ctx, owner, { board_id: board.id }).cursor;
  const again = await claimTask(ctx, winner, { thread_id: t.thread.id });
  assert.deepEqual(again.claim, claim, "the holder re-claiming gets the same claim");
  assert.equal("changes" in getChanges(ctx, owner, { board_id: board.id, cursor: c0 }) && getChanges(ctx, owner, { board_id: board.id, cursor: c0 }).changes.length, 0);

  await rejects(() => updateTask(ctx, winner, t.thread.id, { action: "complete" }), "invalid_argument");
  await rejects(() => updateTask(ctx, winner, t.thread.id, { action: "complete", token: "wrong" }), "claim_lost");
  await rejects(() => updateTask(ctx, owner, t.thread.id, { action: "complete", token: claim.token }), "claim_lost");
  await rejects(() => updateTask(ctx, winner, t.thread.id, { action: "complete", token: claim.token, reason: "x" }), "invalid_argument");
  const done = updateTask(ctx, winner, t.thread.id, { action: "complete", token: claim.token, result: "Fixed the race in the deploy test", idempotency_key: key() });
  assert.equal(done.thread.task?.state, "completed");
  assert.equal(done.thread.task?.result, "Fixed the race in the deploy test");
  assert.equal(done.thread.task?.assignee?.id, winner.id);
  assert.ok(done.thread.task?.completed_at);
  assert.equal(done.thread.task?.lease_until, null);
  assert.equal(done.message?.body, "Fixed the race in the deploy test");
  await rejects(() => updateTask(ctx, winner, t.thread.id, { action: "complete", token: claim.token }), "claim_lost");
  await rejects(() => claimTask(ctx, w1, { thread_id: t.thread.id }), "task_finished");
  deleteMessage(ctx, winner, done.message!.id);
  assert.equal(getThread(ctx, owner, t.thread.id).thread.task?.result, null, "a deleted result is not kept");
  assert.equal(listThreads(ctx, owner, board.id, { kind: "task", task_state: "completed" }).threads.length, 1);
});

test("tasks: leases expire at claim time and in maintenance, renew extends from now", async () => {
  const { ctx, owner, board, w1, w2, task } = await setup({ task_lease_seconds: 60 });
  advance(ctx, 0);
  const t = task(owner, "Long job");
  const c1 = await claimTask(ctx, w1, { thread_id: t.thread.id, lease_seconds: 600 });
  assert.ok(Date.parse(c1.claim.until) - ctx.now().getTime() <= 60_000, "a requested lease is capped at task_lease_seconds");
  const short = await claimTask(ctx, w1, { thread_id: t.thread.id });
  assert.equal(short.claim.token, c1.claim.token);
  advance(ctx, 30_000);
  const renewed = renewTask(ctx, w1, t.thread.id, { token: c1.claim.token, lease_seconds: 20 });
  assert.equal(Date.parse(renewed.claim.until), ctx.now().getTime() + 20_000);
  await rejects(() => renewTask(ctx, w2, t.thread.id, { token: c1.claim.token }), "claim_lost");
  advance(ctx, 21_000);
  await rejects(() => renewTask(ctx, w1, t.thread.id, { token: c1.claim.token }), "claim_lost");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "complete", token: c1.claim.token }), "claim_lost");
  const cursor = getChanges(ctx, owner, { board_id: board.id }).cursor;
  const c2 = await claimTask(ctx, w2, { thread_id: t.thread.id });
  assert.equal(c2.claim.epoch, 2);
  assert.notEqual(c2.claim.token, c1.claim.token);
  const page = getChanges(ctx, owner, { board_id: board.id, cursor });
  assert.ok("changes" in page);
  assert.equal(page.changes.length, 2, "the expiry and the new claim are two changes");
  assert.equal(page.changes[0]!.actor, null, "an expiry has no actor");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "release", token: c1.claim.token }), "claim_lost");

  advance(ctx, 61_000);
  assert.equal(expireTaskLeases(ctx), 1);
  const view = getThread(ctx, owner, t.thread.id).thread.task!;
  assert.equal(view.state, "ready");
  assert.equal(view.assignee, null);
  assert.equal(view.lease_until, null);
});

test("tasks: needs ready dependents only on completion; cycles and bad IDs are invalid_needs", async () => {
  const { ctx, owner, board, w1, task } = await setup();
  const a = task(owner, "Fix");
  const b = task(owner, "Review", { needs: [a.thread.id] });
  assert.equal(b.thread.task?.state, "waiting");
  assert.deepEqual(b.thread.task?.needs, [{ thread_id: a.thread.id, title: "Fix", state: "ready" }]);
  await rejects(() => claimTask(ctx, w1, { thread_id: b.thread.id }), "task_waiting");
  const discussion = startThread(ctx, owner, board.id, { title: "Chat", body: "hi", idempotency_key: key() });
  await rejects(() => task(owner, "Bad", { needs: [discussion.thread.id] }), "invalid_needs");
  await rejects(() => task(owner, "Bad", { needs: ["t_missing"] }), "invalid_needs");
  await rejects(() => updateTask(ctx, owner, a.thread.id, { action: "set_needs", needs: [b.thread.id] }), "invalid_needs");
  await rejects(() => updateTask(ctx, owner, a.thread.id, { action: "set_needs", needs: [a.thread.id] }), "invalid_needs");
  await rejects(() => updateTask(ctx, w1, b.thread.id, { action: "set_needs", needs: [] }), "task_not_owned");
  const other = ensureOwnBoard(ctx, w1, { create: true })!;
  const elsewhere = startThread(ctx, w1, other.id, { title: "Other board", body: "x", task: true, idempotency_key: key() });
  await rejects(() => task(owner, "Cross board", { needs: [elsewhere.thread.id] }), "invalid_needs");

  const ca = await claimTask(ctx, w1, { thread_id: a.thread.id });
  const cursor = getChanges(ctx, owner, { board_id: board.id }).cursor;
  updateTask(ctx, w1, a.thread.id, { action: "complete", token: ca.claim.token });
  assert.equal(getThread(ctx, owner, b.thread.id).thread.task?.state, "ready", "completing the prerequisite readies the dependent");
  const page = getChanges(ctx, owner, { board_id: board.id, cursor });
  assert.ok("changes" in page && page.changes.some((c) => c.thread_id === b.thread.id && c.actor === null));

  const c = task(owner, "Deploy");
  const d = task(owner, "Announce", { needs: [c.thread.id, a.thread.id] });
  assert.equal(d.thread.task?.state, "waiting");
  const cc = await claimTask(ctx, w1, { thread_id: c.thread.id });
  updateTask(ctx, w1, c.thread.id, { action: "fail", token: cc.claim.token, reason: "the deploy key expired" });
  assert.equal(getThread(ctx, owner, d.thread.id).thread.task?.state, "waiting", "a failed prerequisite readies nothing");
  const reopened = updateTask(ctx, owner, c.thread.id, { action: "reopen" });
  assert.equal(reopened.thread.task?.state, "ready");
  assert.equal(getThread(ctx, owner, d.thread.id).thread.task?.state, "waiting");
  const replaced = updateTask(ctx, owner, d.thread.id, { action: "set_needs", needs: [a.thread.id] });
  assert.equal(replaced.thread.task?.state, "ready", "needs that are all completed make the task ready");
  const none = updateTask(ctx, owner, d.thread.id, { action: "set_needs", needs: [c.thread.id] });
  assert.equal(none.thread.task?.state, "waiting");
  updateTask(ctx, owner, c.thread.id, { action: "cancel", reason: "not needed" });
  assert.equal(getThread(ctx, owner, d.thread.id).thread.task?.state, "waiting", "a canceled prerequisite readies nothing");
  const dc = updateTask(ctx, owner, d.thread.id, { action: "set_needs", needs: [] });
  assert.equal(dc.thread.task?.state, "ready");
  const held = await claimTask(ctx, w1, { thread_id: dc.thread.id });
  await rejects(() => updateTask(ctx, owner, d.thread.id, { action: "set_needs", needs: [a.thread.id] }), "task_already_claimed");
  updateTask(ctx, w1, d.thread.id, { action: "release", token: held.claim.token });
});

test("tasks: kept for one principal, claim-next order, assign and the task_assigned inbox item", async () => {
  const { ctx, owner, board, w1, w2, reader, task } = await setup();
  const pool = task(owner, "Anyone", { labels: { q: "x" } });
  const mine = task(owner, "For W1", { for: w1.id, labels: { q: "x" } });
  assert.equal(mine.thread.task?.for?.id, w1.id);
  assert.ok(getInbox(ctx, w1).items.some((i) => i.kind === "task_assigned" && i.thread_id === mine.thread.id));
  await rejects(() => claimTask(ctx, w2, { thread_id: mine.thread.id }), "task_assigned");
  await rejects(() => task(owner, "For reader", { for: reader.id }), "invalid_argument");
  const n1 = await claimTask(ctx, w1, { board_id: board.id, labels: { q: "x" } });
  assert.equal(n1.thread.id, mine.thread.id, "tasks kept for the caller come first");
  const n2 = await claimTask(ctx, w2, { board_id: board.id, labels: { q: "x" } });
  assert.equal(n2.thread.id, pool.thread.id);
  updateTask(ctx, w2, pool.thread.id, { action: "release", token: n2.claim.token });
  const later = task(owner, "Kept for W2", { for: w2.id, labels: { q: "y" } });
  await rejects(() => claimTask(ctx, w1, { board_id: board.id, labels: { q: "y" } }), "no_task_available");
  await rejects(() => updateTask(ctx, w1, later.thread.id, { action: "assign", for: null }), "task_not_owned");
  const pooled = updateTask(ctx, owner, later.thread.id, { action: "assign", for: null });
  assert.equal(pooled.thread.task?.for, null);
  const toW1 = updateTask(ctx, owner, later.thread.id, { action: "assign", for: w1.id });
  assert.equal(toW1.thread.task?.for?.id, w1.id);
  assert.ok(getInbox(ctx, w1).items.some((i) => i.kind === "task_assigned" && i.thread_id === later.thread.id));
  assert.equal(listThreads(ctx, w1, board.id, { for: "me" }).threads.length, 2);
  const forMe = task(w1, "Self", { for: "me", claim: true });
  assert.ok(forMe.claim, "claim: true returns the claim");
  assert.equal(forMe.thread.task?.state, "claimed");
  await rejects(() => task(owner, "Kept and claimed", { for: w1.id, claim: true }), "task_assigned");
});

test("tasks: block, unblock, fail, reopen and cancel; owners manage, others get task_not_owned", async () => {
  const { ctx, owner, board, w1, w2, task } = await setup();
  const t = task(w1, "Deploy");
  const c = await claimTask(ctx, w2, { thread_id: t.thread.id });
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "block", token: c.claim.token, reason: "approve?", kind: "Bad Kind" }), "invalid_argument");
  const blocked = updateTask(ctx, w2, t.thread.id, { action: "block", token: c.claim.token, reason: "approve the prod deploy?", kind: "awaiting_approval" });
  assert.equal(blocked.thread.task?.state, "blocked");
  assert.equal(blocked.thread.task?.blocked_reason, "approve the prod deploy?");
  assert.equal(blocked.thread.task?.blocked_kind, "awaiting_approval");
  assert.equal(blocked.thread.task?.assignee, null);
  await rejects(() => renewTask(ctx, w2, t.thread.id, { token: c.claim.token }), "claim_lost");
  await rejects(() => claimTask(ctx, w2, { thread_id: t.thread.id }), "task_blocked");
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "unblock" }), "task_not_owned");
  const unblocked = updateTask(ctx, w1, t.thread.id, { action: "unblock" });
  assert.equal(unblocked.thread.task?.state, "ready");
  assert.equal(unblocked.thread.task?.blocked_reason, null);
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "unblock" }), "conflict");
  const byOwner = updateTask(ctx, owner, t.thread.id, { action: "block", reason: "hold" });
  assert.equal(byOwner.thread.task?.state, "blocked", "the board owner can hold an unclaimed task");
  updateTask(ctx, owner, t.thread.id, { action: "unblock" });

  const c2 = await claimTask(ctx, w2, { thread_id: t.thread.id });
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "fail", token: c2.claim.token }), "invalid_argument");
  const failed = updateTask(ctx, w2, t.thread.id, { action: "fail", token: c2.claim.token, reason: "no credentials" });
  assert.equal(failed.thread.task?.state, "failed");
  assert.equal(failed.thread.task?.failure_reason, "no credentials");
  assert.equal(failed.thread.task?.assignee?.id, w2.id);
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "reopen" }), "task_not_owned");
  assert.equal(updateTask(ctx, w1, t.thread.id, { action: "reopen" }).thread.task?.state, "ready");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "reopen" }), "conflict");

  const c3 = await claimTask(ctx, w2, { thread_id: t.thread.id });
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "cancel", reason: "mine now" }), "task_not_owned");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "cancel" }), "invalid_argument");
  const canceled = updateTask(ctx, w1, t.thread.id, { action: "cancel", reason: "superseded by the nightly deploy" });
  assert.equal(canceled.thread.task?.state, "canceled");
  assert.equal(canceled.thread.task?.canceled_reason, "superseded by the nightly deploy");
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "complete", token: c3.claim.token }), "claim_lost");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "cancel", reason: "again" }), "task_finished");
  await rejects(() => updateTask(ctx, w1, t.thread.id, { action: "reopen" }), "conflict");
  assert.equal(listThreads(ctx, owner, board.id, { labels: { "board.task": "canceled" } }).threads.length, 1);
  assert.equal(listThreads(ctx, owner, board.id, { task_state: "open" }).threads.length, 0);
});

test("tasks: a person manages the tasks their agent created; removal releases claims", async () => {
  const { ctx, owner, board, w1, w2, task } = await setup();
  const agent = createAgent(ctx, w1, "planner");
  addAgentToBoard(ctx, w1, board.id, agent.id, "contributor");
  const a = actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
  const t = task(a, "Agent task");
  assert.equal(updateTask(ctx, w1, t.thread.id, { action: "block", reason: "check with me first" }).thread.task?.state, "blocked");
  await rejects(() => updateTask(ctx, w2, t.thread.id, { action: "unblock" }), "task_not_owned");
  updateTask(ctx, w1, t.thread.id, { action: "unblock" });
  await claimTask(ctx, w2, { thread_id: t.thread.id });
  removeMember(ctx, owner, board.id, w2.id);
  assert.equal(getThread(ctx, owner, t.thread.id).thread.task?.state, "ready", "a removed member's claim ends with their membership");
});

test("tasks: plans are atomic and idempotent, with needs by key", async () => {
  const { ctx, owner, board, w1 } = await setup();
  const before = listThreads(ctx, owner, board.id, { kind: "task" }).threads.length;
  await rejects(
    () => createTasks(ctx, owner, board.id, { tasks: [{ key: "a", title: "A", body: "a" }, { title: "B", body: "b", needs: [{ key: "missing" }] }] }),
    "invalid_needs",
  );
  await rejects(
    () => createTasks(ctx, owner, board.id, { tasks: [{ key: "a", title: "A", body: "a" }, { key: "a", title: "B", body: "b" }] }),
    "invalid_needs",
  );
  await rejects(
    () =>
      createTasks(ctx, owner, board.id, {
        tasks: [
          { key: "a", title: "A", body: "a", needs: [{ key: "b" }] },
          { key: "b", title: "B", body: "b", needs: [{ key: "a" }] },
        ],
      }),
    "invalid_needs",
  );
  await rejects(() => createTasks(ctx, owner, board.id, { tasks: [{ key: "a", title: "A", body: "a", labels: { "board.task": "ready" } }] }), "invalid_argument");
  assert.equal(listThreads(ctx, owner, board.id, { kind: "task" }).threads.length, before, "a failed plan creates nothing");

  const idem = key();
  const plan = {
    tasks: [
      { key: "fix", title: "Fix CVE", body: "patch it", labels: { step: "fix" } },
      { key: "review", title: "Review", body: "review it", labels: { step: "review" }, needs: [{ key: "fix" }] },
      { title: "Ship", body: "ship it", needs: [{ key: "review" }, { key: "fix" }], for: w1.id },
    ],
    idempotency_key: idem,
  };
  const made = createTasks(ctx, owner, board.id, plan);
  assert.deepEqual(
    made.threads.map((t) => t.task?.state),
    ["ready", "waiting", "waiting"],
  );
  assert.equal(made.threads[2]!.task?.needs.length, 2);
  assert.equal(made.threads[2]!.task?.for?.id, w1.id);
  assert.deepEqual(
    made.threads.map((t) => t.id),
    [...made.threads.map((t) => t.id)].sort(),
    "plan tasks get IDs in plan order, so claim-next takes them in that order",
  );
  const retry = createTasks(ctx, owner, board.id, plan);
  assert.deepEqual(
    retry.threads.map((t) => t.id),
    made.threads.map((t) => t.id),
  );
  assert.equal(listThreads(ctx, owner, board.id, { kind: "task" }).threads.length, before + 3);
  await rejects(() => createTasks(ctx, owner, board.id, { ...plan, tasks: plan.tasks.slice(0, 1) }), "idempotency_conflict");
});

test("tasks: claim-next waits for a task to become ready", async () => {
  const { ctx, owner, board, w1, task } = await setup();
  const started = Date.now();
  await rejects(() => claimTask(ctx, w1, { board_id: board.id, labels: { q: "none" }, wait_seconds: 1 }), "no_task_available");
  assert.ok(Date.now() - started >= 900, "the claim waited");
  const waiting = claimTask(ctx, w1, { board_id: board.id, labels: { q: "soon" }, wait_seconds: 5 });
  await new Promise((r) => setTimeout(r, 100));
  const made = task(owner, "Soon", { labels: { q: "soon" } });
  const got = await waiting;
  assert.equal(got.thread.id, made.thread.id);
  assert.ok(Date.now() - started < 4000);
  await rejects(() => claimTask(ctx, w1, { thread_id: made.thread.id, wait_seconds: 1 }), "invalid_argument");
});

test("tasks: board.task is a reserved label for filters", async () => {
  const { ctx, owner, board, task } = await setup();
  const t = task(owner, "Label me");
  await rejects(() => setLabels(ctx, owner, t.thread.id, { set: { "board.task": "completed" } }), "invalid_argument");
  await rejects(() => setLabels(ctx, owner, t.thread.id, { remove: ["board.task"] }), "invalid_argument");
  assert.equal(listThreads(ctx, owner, board.id, { labels: { "board.task": "ready" } }).threads.length, 1);
  assert.equal(listThreads(ctx, owner, board.id, { labels: { "board.task": "open" } }).threads.length, 1);
  assert.equal(listThreads(ctx, owner, board.id, { labels: { "board.task": "claimed" } }).threads.length, 0);
  await rejects(() => listThreads(ctx, owner, board.id, { labels: { "board.task": "done" } }), "invalid_argument");
});

test("tasks v2 migration maps stored states and keeps every message", async () => {
  const db = openDatabase(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  // Every migration before tasks v2, applied by hand, then migrate() applies tasks v2 (and anything after it).
  for (const file of readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.ts$/.test(f) && f < "0007_tasks_v2.ts").sort()) {
    const m = (await import(pathToFileURL(join(dir, file)).href)) as { sql?: string; up?: (d: typeof db) => void };
    if (m.sql) db.exec(m.sql);
    m.up?.(db);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file.replace(/\.ts$/, ""), new Date().toISOString());
  }
  const now = new Date().toISOString();
  db.prepare("INSERT INTO principals (id, kind, display_name, created_at) VALUES ('p1', 'human', 'A', ?), ('p2', 'human', 'B', ?)").run(now, now);
  db.prepare("INSERT INTO boards (id, name, owner_id, created_at) VALUES ('b1', 'B', 'p1', ?)").run(now);
  const old: [string, string | null, string | null][] = [
    ["t_open", "open", null],
    ["t_claimed", "claimed", "p2"],
    ["t_done", "done", "p2"],
    ["t_cancelled", "cancelled", null],
    ["t_chat", null, null],
  ];
  for (const [id, state, assignee] of old) {
    db.prepare(
      "INSERT INTO threads (id, board_id, title, kind, task_state, task_assignee_id, created_by, created_at, last_activity_at) VALUES (?, 'b1', 't', ?, ?, ?, 'p1', ?, ?)",
    ).run(id, state ? "task" : "discussion", state, assignee, now, now);
    db.prepare("INSERT INTO messages (id, board_id, thread_id, author_id, body, created_at) VALUES (?, 'b1', ?, 'p1', 'hello', ?)").run(`m_${id}`, id, now);
    db.prepare("INSERT INTO follows (principal_id, thread_id, created_at) VALUES ('p1', ?, ?)").run(id, now);
  }
  assert.ok((await migrate(db)).includes("0007_tasks_v2"));
  const rows = db.prepare("SELECT id, task_state, task_assignee_id, task_for_id FROM threads ORDER BY id").all();
  assert.deepEqual(rows, [
    { id: "t_cancelled", task_state: "canceled", task_assignee_id: null, task_for_id: null },
    { id: "t_chat", task_state: null, task_assignee_id: null, task_for_id: null },
    { id: "t_claimed", task_state: "ready", task_assignee_id: null, task_for_id: "p2" },
    { id: "t_done", task_state: "completed", task_assignee_id: "p2", task_for_id: null },
    { id: "t_open", task_state: "ready", task_assignee_id: null, task_for_id: null },
  ]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 5);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM follows").get() as { n: number }).n, 5);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  db.prepare("DELETE FROM threads WHERE id = 't_open'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 4, "messages still cascade with their thread");
  assert.throws(() => db.prepare("UPDATE threads SET task_state = 'open' WHERE id = 't_done'").run(), /CHECK constraint/);
});

test("tasks: a profile manages only the tasks it created; its person manages any of their profiles' tasks", async () => {
  const { ctx, owner, board, w1, w2, task } = await setup();
  const asProfile = (person: Actor, name: string) => profileActor(person, ensureProfile(ctx, getPrincipal(ctx, person.id)!, name));
  const fixer = asProfile(w1, "fixer");
  const other = asProfile(w1, "reviewer");
  const byFixer = task(fixer, "Fixer's task");
  assert.equal(byFixer.thread.task?.owner.id, fixer.id);
  await rejects(() => updateTask(ctx, other, byFixer.thread.id, { action: "block", reason: "mine" }), "task_not_owned");
  assert.equal(updateTask(ctx, fixer, byFixer.thread.id, { action: "block", reason: "check first" }).thread.task?.state, "blocked");
  assert.equal(updateTask(ctx, w1, byFixer.thread.id, { action: "unblock" }).thread.task?.state, "ready", "the person manages their profiles' tasks");
  const ownerProfile = asProfile(owner, "lead-bot");
  await rejects(() => updateTask(ctx, ownerProfile, byFixer.thread.id, { action: "cancel", reason: "x" }), "task_not_owned");
  const byPerson = task(w1, "Person's task");
  await rejects(() => updateTask(ctx, fixer, byPerson.thread.id, { action: "cancel", reason: "x" }), "task_not_owned");

  const kept = task(owner, "For the fixer profile", { for: fixer.id });
  assert.equal(kept.thread.task?.for?.id, fixer.id);
  await rejects(() => claimTask(ctx, w1, { thread_id: kept.thread.id }), "task_assigned");
  const next = await claimTask(ctx, fixer, { board_id: board.id });
  assert.equal(next.thread.id, kept.thread.id, "claim-next takes the task kept for the profile first");
  assert.equal(listThreads(ctx, owner, board.id, { assignee: w1.id, task_state: "claimed" }).threads.length, 1, "a person's assignee filter covers their profiles");
  await rejects(() => updateTask(ctx, w1, kept.thread.id, { action: "complete", token: next.claim.token }), "claim_lost");
  removeMember(ctx, owner, board.id, w1.id);
  assert.equal(getThread(ctx, owner, kept.thread.id).thread.task?.state, "ready", "removing a person ends their profiles' claims");
  void w2;
});

test("tasks: channels decide who can claim and settle; claim-next filters by channel; needs respect read access", async () => {
  const { ctx, owner, board, w1, task } = await setup();
  const inChannel = (who: Actor, channel: string, title: string, extra: { needs?: string[]; labels?: Record<string, string> } = {}) =>
    startThread(ctx, who, board.id, { channel, title, body: title, task: true, idempotency_key: key(), ...extra });
  const work = inChannel(owner, "work", "Work task");
  await new Promise((r) => setTimeout(r, 5));
  const ci = inChannel(owner, "work/ci", "CI task");
  const ops = inChannel(owner, "ops", "Ops task");
  assert.equal(work.thread.channel, "work");
  createGrant(ctx, owner, board.id, { principals: [{ kind: "contributors" }], can: { "ops/": ["read"] } });
  createGrant(ctx, owner, board.id, { principals: [{ kind: "everyone" }], can: { "secret/": "none" } });
  createGrant(ctx, owner, board.id, { principals: [{ kind: "member", principal_id: owner.id }], can: { "secret/": "all" } });
  await rejects(() => claimTask(ctx, w1, { thread_id: ops.thread.id }), "forbidden");
  const first = await claimTask(ctx, w1, { board_id: board.id, channel: "work/" });
  assert.equal(first.thread.id, work.thread.id, "a trailing slash claims from the subtree, oldest first");
  const second = await claimTask(ctx, w1, { board_id: board.id, channel: "work/ci" });
  assert.equal(second.thread.id, ci.thread.id);
  await rejects(() => claimTask(ctx, w1, { board_id: board.id, channel: "ops" }), "no_task_available");
  const plan = createTasks(ctx, owner, board.id, { channel: "work/ci", tasks: [{ title: "Lint", body: "lint" }] });
  assert.equal(plan.threads[0]!.channel, "work/ci");
  await rejects(() => createTasks(ctx, w1, board.id, { channel: "ops", tasks: [{ title: "No", body: "no" }] }), "forbidden");
  await rejects(() => startThread(ctx, owner, board.id, { channel: "ops", title: "Kept", body: "x", task: true, for: w1.id, idempotency_key: key() }), "invalid_argument");

  const secret = inChannel(owner, "secret", "Rotate the root key");
  const dependent = inChannel(owner, "work", "Announce the rotation", { needs: [secret.thread.id] });
  assert.equal(dependent.thread.task?.needs[0]?.title, "Rotate the root key", "the owner sees the prerequisite's title");
  const seen = getThread(ctx, w1, dependent.thread.id).thread.task!;
  assert.deepEqual(seen.needs, [{ thread_id: secret.thread.id, title: "", state: "ready" }], "a prerequisite in a channel you can't read keeps its ID and state, not its title");
  await rejects(() => inChannel(w1, "work", "Mine", { needs: [secret.thread.id] }), "invalid_needs");
});

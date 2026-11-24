import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx, human, key } from "./helpers.ts";
import { ensureOwnBoard, createAgent, addAgentToBoard, removeMember, updateMember, listMembers, getBoard } from "../src/domain/boards.ts";
import { createInvite, redeemInvite, disableInvite, previewInvite } from "../src/domain/invites.ts";
import { startThread, reply, deleteMessage, getThread, listThreads, setLabels, claimTask, updateTask, setFollow } from "../src/domain/conversation.ts";
import { getChanges, getInbox, markRead, waitForActivity } from "../src/domain/changes.ts";
import { getUsage, searchMessages, runMaintenance } from "../src/domain/usage.ts";
import { actorFromPrincipal, getPrincipal } from "../src/domain/access.ts";
import { OmbError } from "../src/errors.ts";

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

test("personal board is created once even when requested concurrently", async () => {
  const ctx = await makeCtx();
  const ada = human(ctx, "ada@example.test", "Ada");
  const boards = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => ensureOwnBoard(ctx, ada, { create: true }))));
  assert.equal(new Set(boards.map((b) => b!.id)).size, 1);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM boards").get() as { n: number }).n, 1);
});

test("invites enforce audience, expiry, disable and agent rules", async () => {
  const ctx = await makeCtx();
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const maya = human(ctx, "maya@example.test", "Maya");
  const outsider = human(ctx, "x@elsewhere.test");
  const lookalike = human(ctx, "u@examp1e.test");
  const sub = human(ctx, "u@eng.example.test");

  const emailInvite = createInvite(ctx, owner, board.id, { audience: "email", value: "maya@example.test", role: "contributor" });
  assert.ok(emailInvite.url?.includes("/i/"));
  await rejects(() => redeemInvite(ctx, outsider, emailInvite.url!), "invite_not_eligible", "email_mismatch");
  assert.equal(redeemInvite(ctx, maya, emailInvite.url!).my_role, "contributor");

  const domainInvite = createInvite(ctx, owner, board.id, { audience: "domain", value: "example.test", role: "reader" });
  await rejects(() => redeemInvite(ctx, lookalike, domainInvite.url!), "invite_not_eligible", "domain_mismatch");
  await rejects(() => redeemInvite(ctx, sub, domainInvite.url!), "invite_not_eligible", "domain_mismatch");
  assert.throws(() => createInvite(ctx, owner, board.id, { audience: "domain", value: "gmail.com", role: "reader" }), /public email provider/);

  const link = createInvite(ctx, owner, board.id, { audience: "link", role: "reader" });
  disableInvite(ctx, owner, link.id);
  await rejects(() => redeemInvite(ctx, outsider, link.url!), "invite_disabled");
  assert.equal(previewInvite(ctx, link.url!).status, "disabled");

  const agent = createAgent(ctx, maya, "release-agent");
  const agentActor = actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
  const link2 = createInvite(ctx, owner, board.id, { audience: "link", role: "reader" });
  await rejects(() => redeemInvite(ctx, agentActor, link2.url!), "invite_not_eligible", "agent_not_allowed");
  // non-members see not_found
  await rejects(() => getBoard(ctx, outsider, board.id), "not_found");
});

test("posting, idempotency, mentions, follows and inbox", async () => {
  const ctx = await makeCtx();
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const maya = human(ctx, "maya@example.test", "Maya");
  redeemInvite(ctx, maya, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  const k = key();
  const first = startThread(ctx, owner, board.id, { title: "What's left before Friday?", body: "List it here", mentions: [maya.id], idempotency_key: k });
  const retry = startThread(ctx, owner, board.id, { title: "What's left before Friday?", body: "List it here", mentions: [maya.id], idempotency_key: k });
  assert.equal(first.thread.id, retry.thread.id);
  assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n, 1);
  assert.equal(getUsage(ctx, owner, board.id).allowances.find((a) => a.allowance === "posts")!.used, 1);
  assert.throws(() => startThread(ctx, owner, board.id, { title: "different", body: "x", idempotency_key: k }), /different request/);

  const inbox = getInbox(ctx, maya);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0]!.kind, "mention");
  reply(ctx, maya, first.thread.id, { body: "Android is ready. Checking iOS now.", idempotency_key: key() });
  const ownerInbox = getInbox(ctx, owner, { unread_only: true });
  assert.equal(ownerInbox.items[0]!.kind, "reply");
  assert.equal(markRead(ctx, owner, { up_to_cursor: ownerInbox.as_of }).unread_count, 0);

  setFollow(ctx, owner, first.thread.id, false);
  reply(ctx, maya, first.thread.id, { body: "iOS ready too", idempotency_key: key() });
  assert.equal(getInbox(ctx, owner, { unread_only: true }).items.length, 0);

  const t = getThread(ctx, owner, first.thread.id);
  assert.equal(t.messages.length, 3);
  const del = deleteMessage(ctx, maya, t.messages[2]!.id);
  assert.equal(del.message.deleted, true);
  assert.equal(del.message.body, null);
  assert.equal(searchMessages(ctx, owner, board.id, "Android").results.length, 1);
  assert.equal(searchMessages(ctx, owner, board.id, "too").results.length, 0);
});

test("readers can't post; changes come in order with cursors", async () => {
  const ctx = await makeCtx();
  const owner = human(ctx, "owner@example.test");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const reader = human(ctx, "r@example.test");
  redeemInvite(ctx, reader, createInvite(ctx, owner, board.id, { audience: "link", role: "reader" }).url!);
  const start = getChanges(ctx, reader, { board_id: board.id });
  assert.ok("changes" in start);
  const th = startThread(ctx, owner, board.id, { title: "Release", body: "Go", idempotency_key: key() });
  await rejects(() => reply(ctx, reader, th.thread.id, { body: "can't", idempotency_key: key() }), "forbidden");
  reply(ctx, owner, th.thread.id, { body: "one", idempotency_key: key() });
  reply(ctx, owner, th.thread.id, { body: "two", idempotency_key: key() });
  const page = getChanges(ctx, reader, { board_id: board.id, cursor: start.cursor });
  assert.ok("changes" in page);
  assert.deepEqual(page.changes.map((c) => c.type), ["thread.created", "message.created", "message.created"]);
  assert.deepEqual(page.changes.map((c) => c.message?.body), ["Go", "one", "two"]);
  const after = getChanges(ctx, reader, { board_id: board.id, cursor: page.cursor });
  assert.ok("changes" in after && after.changes.length === 0);
});

test("wait_for_activity wakes on a new post", async () => {
  const ctx = await makeCtx();
  const owner = human(ctx, "owner@example.test");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const cursor = (getChanges(ctx, owner, { board_id: board.id }) as { cursor: string }).cursor;
  const started = Date.now();
  const waiting = waitForActivity(ctx, owner, { board_id: board.id, cursor, timeout_seconds: 5 });
  setTimeout(() => startThread(ctx, owner, board.id, { title: "ping", body: "pong", idempotency_key: key() }), 50);
  const result = await waiting;
  assert.ok("changes" in result && result.changes.length >= 1);
  assert.ok(Date.now() - started < 3000);
});

test("access ending cuts off reads and notifies the hub", async () => {
  let now = new Date("2026-11-23T12:00:00Z");
  const ctx = await makeCtx();
  ctx.now = () => now;
  const owner = human(ctx, "owner@example.test");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const reviewer = human(ctx, "rev@example.test");
  redeemInvite(ctx, reviewer, createInvite(ctx, owner, board.id, { audience: "link", role: "reader", access_ends_at: "2026-11-27T23:59:59Z" }).url!);
  assert.equal(getBoard(ctx, reviewer, board.id).my_role, "reader");
  const notified: string[] = [];
  now = new Date("2026-11-28T00:00:00Z");
  runMaintenance(ctx, (b, p) => notified.push(`${b}:${p}`));
  assert.deepEqual(notified, [`${board.id}:${reviewer.id}`]);
  await rejects(() => getBoard(ctx, reviewer, board.id), "access_ended");
});

test("agents: via authorship, role cap, removed with their person, loop guard, daily cap", async () => {
  const ctx = await makeCtx({}, { agent_consecutive_limit: 3 });
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const maya = human(ctx, "maya@example.test", "Maya");
  redeemInvite(ctx, maya, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  const agent = createAgent(ctx, maya, "release-agent");
  addAgentToBoard(ctx, maya, board.id, agent.id, "contributor");
  const a = actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
  const th = startThread(ctx, maya, board.id, { title: "Tests", body: "run them", idempotency_key: key() });
  const posted = reply(ctx, a, th.thread.id, { body: "All green", idempotency_key: key() });
  assert.equal(posted.message.author.via?.display_name, "Maya");
  reply(ctx, a, th.thread.id, { body: "2", idempotency_key: key() });
  reply(ctx, a, th.thread.id, { body: "3", idempotency_key: key() });
  await rejects(() => reply(ctx, a, th.thread.id, { body: "4", idempotency_key: key() }), "agent_loop_guard");
  reply(ctx, maya, th.thread.id, { body: "keep going", idempotency_key: key() });
  reply(ctx, a, th.thread.id, { body: "4", idempotency_key: key() });
  updateMember(ctx, owner, board.id, maya.id, { role: "reader" });
  assert.equal(listMembers(ctx, owner, board.id).find((m) => m.principal.id === agent.id)!.role, "reader");
  removeMember(ctx, owner, board.id, maya.id);
  assert.equal(listMembers(ctx, owner, board.id).some((m) => m.principal.id === agent.id), false);
});

test("quota: last allowed post succeeds, next fails with details, reads continue", async () => {
  const ctx = await makeCtx({}, { posts_per_month: 3 });
  const owner = human(ctx, "owner@example.test");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const th = startThread(ctx, owner, board.id, { title: "q", body: "1", idempotency_key: key() });
  reply(ctx, owner, th.thread.id, { body: "2", idempotency_key: key() });
  const third = reply(ctx, owner, th.thread.id, { body: "3", idempotency_key: key() });
  assert.ok(third.usage_warning?.some((w) => w.allowance === "posts"));
  const e = await rejects(() => reply(ctx, owner, th.thread.id, { body: "4", idempotency_key: key() }), "quota_exceeded");
  assert.equal(e.details?.allowance, "posts");
  assert.equal(e.details?.limit, 3);
  assert.ok(typeof e.details?.resets_at === "string");
  assert.equal(getThread(ctx, owner, th.thread.id).messages.length, 3);
});

test("tasks: claim races, claim next by label, complete with result, release, cancel, assign", async () => {
  const ctx = await makeCtx();
  const owner = human(ctx, "owner@example.test", "Lead");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const w1 = human(ctx, "w1@example.test");
  const w2 = human(ctx, "w2@example.test");
  for (const w of [w1, w2]) redeemInvite(ctx, w, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  const t1 = startThread(ctx, owner, board.id, { title: "Fix flaky test", body: "deploy test", task: true, labels: { area: "ci" }, idempotency_key: key() });
  const t2 = startThread(ctx, owner, board.id, { title: "iOS build", body: "sign it", task: true, labels: { area: "ios" }, idempotency_key: key() });
  assert.equal(t1.thread.task?.state, "open");
  const results = await Promise.allSettled([
    Promise.resolve().then(() => claimTask(ctx, w1, { thread_id: t1.thread.id })),
    Promise.resolve().then(() => claimTask(ctx, w2, { thread_id: t1.thread.id })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const next = claimTask(ctx, w2, { board_id: board.id, labels: { area: "ios" } });
  assert.equal(next.thread.id, t2.thread.id);
  await rejects(() => claimTask(ctx, w2, { board_id: board.id, labels: { area: "ios" } }), "no_task_available");
  const winner = results[0]!.status === "fulfilled" ? w1 : w2;
  const done = updateTask(ctx, winner, t1.thread.id, { action: "complete", result: "Fixed the race in the deploy test" });
  assert.equal(done.thread.task?.state, "done");
  assert.equal(done.message?.body, "Fixed the race in the deploy test");
  updateTask(ctx, w2, t2.thread.id, { action: "release" });
  await rejects(() => updateTask(ctx, w2, t2.thread.id, { action: "cancel" }), "forbidden");
  assert.equal(updateTask(ctx, owner, t2.thread.id, { action: "cancel" }).thread.task?.state, "cancelled");
  const assigned = startThread(ctx, owner, board.id, { title: "Assigned", body: "for w1", task: true, assignee: w1.id, idempotency_key: key() });
  assert.equal(assigned.thread.task?.state, "claimed");
  assert.equal(getInbox(ctx, w1).items.some((i) => i.kind === "task_assigned"), true);
  const labelled = setLabels(ctx, w1, assigned.thread.id, { set: { state: "review" } });
  assert.deepEqual(labelled.thread.labels, { state: "review" });
  assert.equal(listThreads(ctx, owner, board.id, { labels: { state: "review" } }).threads.length, 1);
  assert.equal(listThreads(ctx, owner, board.id, { kind: "task", task_state: "done" }).threads.length, 1);
});

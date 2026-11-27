import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "@openmessageboard/core/context";
import { OmbError } from "@openmessageboard/core/errors";
import { ensureOwnBoard } from "@openmessageboard/core/domain/boards";
import { getInbox } from "@openmessageboard/core/domain/changes";
import { createChannel, createGrant } from "@openmessageboard/core/domain/channels";
import { reply, setFollow, startThread } from "@openmessageboard/core/domain/conversation";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { ensureProfile, profileActor } from "@openmessageboard/core/domain/profiles";
import { listSubscriptions, setSubscription, subscriptionLevels } from "@openmessageboard/core/domain/subscriptions";
import { getUsage } from "@openmessageboard/core/domain/usage";
import type { Actor } from "@openmessageboard/core/domain/model";
import { human, key, makeCtx } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof OmbError && e.code === c;

async function boardWith(ctx: AppContext) {
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const join = (email: string, name: string, role: "reader" | "contributor") => {
    const a = human(ctx, email, name);
    redeemInvite(ctx, a, createInvite(ctx, owner, board.id, { audience: "email", value: email, role }).url!);
    return a;
  };
  return { owner, maya: join("maya@example.test", "Maya", "contributor"), rita: join("rita@example.test", "Rita", "reader"), boardId: board.id };
}

const post = (ctx: AppContext, a: Actor, boardId: string, channel: string, title: string, extra: Record<string, unknown> = {}) =>
  startThread(ctx, a, boardId, { channel, title, body: `${title} body`, idempotency_key: key(), ...extra });
const answer = (ctx: AppContext, a: Actor, threadId: string, body: string, extra: Record<string, unknown> = {}) => reply(ctx, a, threadId, { body, idempotency_key: key(), ...extra });
/** The kinds of a principal's inbox items for one thread, oldest first. */
const kinds = (ctx: AppContext, a: Actor, threadId: string) =>
  getInbox(ctx, a, {})
    .items.filter((i) => i.thread_id === threadId)
    .map((i) => i.kind)
    .reverse();

test("threads: one thread item for a new thread, nothing for a later reply", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  assert.equal(setSubscription(ctx, maya, boardId, "support/", "threads").subscription?.level, "threads");
  const t = post(ctx, owner, boardId, "support/billing", "Refund");
  answer(ctx, owner, t.thread.id, "More detail");
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["thread"]);
  const item = getInbox(ctx, maya, {}).items.find((i) => i.thread_id === t.thread.id)!;
  assert.equal(item.message?.id, t.message.id, "a thread item carries the root message");
  // A channel the pattern does not cover creates nothing.
  const other = post(ctx, owner, boardId, "chatter", "Lunch");
  assert.deepEqual(kinds(ctx, maya, other.thread.id), []);
});

test("all: a message item per reply; a mention or a followed thread's reply wins, never both", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  setSubscription(ctx, maya, boardId, "*", "all");
  const t = post(ctx, owner, boardId, "incidents", "Outage");
  answer(ctx, owner, t.thread.id, "Investigating");
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["thread", "message"]);
  answer(ctx, owner, t.thread.id, "Maya, can you look?", { mentions: [maya.id] });
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["thread", "message", "mention"]);
  setFollow(ctx, maya, t.thread.id, true);
  answer(ctx, owner, t.thread.id, "Fixed");
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["thread", "message", "mention", "reply"]);
});

test("mute: replies in a followed thread create nothing; a mention still arrives", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  const t = post(ctx, maya, boardId, "chatter", "Coffee"); // maya follows her own thread
  setSubscription(ctx, maya, boardId, "chatter", "mute");
  answer(ctx, owner, t.thread.id, "Yes please");
  assert.deepEqual(kinds(ctx, maya, t.thread.id), []);
  answer(ctx, owner, t.thread.id, "Maya?", { mentions: [maya.id] });
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["mention"]);
  // Removing the subscription brings the default back.
  assert.equal(setSubscription(ctx, maya, boardId, "chatter", null).subscription, null);
  answer(ctx, owner, t.thread.id, "Still there?");
  assert.deepEqual(kinds(ctx, maya, t.thread.id), ["mention", "reply"]);
});

test("the most specific pattern decides", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  setSubscription(ctx, maya, boardId, "www/", "all");
  setSubscription(ctx, maya, boardId, "www/preview", "mute");
  setSubscription(ctx, maya, boardId, "*", "threads");
  assert.equal(subscriptionLevels(ctx, boardId, "www/production").get(maya.id), "all");
  assert.equal(subscriptionLevels(ctx, boardId, "www/preview").get(maya.id), "mute");
  assert.equal(subscriptionLevels(ctx, boardId, "www").get(maya.id), "all");
  assert.equal(subscriptionLevels(ctx, boardId, "dev").get(maya.id), "threads");
  const prod = post(ctx, owner, boardId, "www/production", "Deploy");
  const preview = post(ctx, owner, boardId, "www/preview", "Preview");
  assert.deepEqual(kinds(ctx, maya, prod.thread.id), ["thread"]);
  assert.deepEqual(kinds(ctx, maya, preview.thread.id), []);
});

test("no item from a channel the subscriber cannot read, and none for one's own message", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  setSubscription(ctx, maya, boardId, "*", "all");
  setSubscription(ctx, owner, boardId, "*", "all");
  createChannel(ctx, owner, boardId, { path: "security", private: true });
  const hidden = post(ctx, owner, boardId, "security", "Leak");
  assert.deepEqual(kinds(ctx, maya, hidden.thread.id), []);
  assert.deepEqual(kinds(ctx, owner, hidden.thread.id), [], "the author gets no item for their own thread");
  // Access granted later: items begin with the next message, never retroactively.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: maya.id }], can: { "security/": ["read"] } });
  answer(ctx, owner, hidden.thread.id, "Contained");
  assert.deepEqual(kinds(ctx, maya, hidden.thread.id), ["message"]);
});

test("each principal has its own subscriptions: a profile's fill the profile's inbox", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  const bot = profileActor(maya, ensureProfile(ctx, maya, "triage"));
  setSubscription(ctx, bot, boardId, "support/", "threads");
  assert.deepEqual(listSubscriptions(ctx, maya, boardId).subscriptions, []);
  assert.deepEqual(listSubscriptions(ctx, bot, boardId).subscriptions.map((s) => `${s.pattern}=${s.level}`), ["support/=threads"]);
  const t = post(ctx, owner, boardId, "support", "Help");
  assert.deepEqual(kinds(ctx, bot, t.thread.id), ["thread"]);
  assert.deepEqual(kinds(ctx, maya, t.thread.id), []);
});

test("set, replace, list, limit and who may subscribe", async () => {
  const ctx = await makeCtx();
  const { owner, maya, rita, boardId } = await boardWith(ctx);
  const outsider = human(ctx, "out@example.test", "Out");
  assert.throws(() => setSubscription(ctx, outsider, boardId, "*", "all"), code("not_found"));
  assert.throws(() => listSubscriptions(ctx, outsider, boardId), code("not_found"));
  // A reader may subscribe: it is a preference about their own inbox.
  assert.equal(setSubscription(ctx, rita, boardId, "*", "threads").subscription?.pattern, "*");
  const first = setSubscription(ctx, maya, boardId, "dev", "all").subscription!;
  const replaced = setSubscription(ctx, maya, boardId, "dev", "mute").subscription!;
  assert.equal(replaced.level, "mute");
  assert.equal(replaced.created_at, first.created_at);
  assert.equal(listSubscriptions(ctx, maya).subscriptions.length, 1);
  const limit = getUsage(ctx, owner, boardId).allowances.find((a) => a.allowance === "subscriptions")!;
  assert.equal(limit.limit, 50);
  for (let i = 1; i < limit.limit; i++) setSubscription(ctx, maya, boardId, `c${i}`, "threads");
  assert.throws(
    () => setSubscription(ctx, maya, boardId, "one-too-many", "threads"),
    (e: unknown) => e instanceof OmbError && e.code === "quota_exceeded" && e.details?.allowance === "subscriptions" && e.details.limit === 50,
  );
  // Replacing one at the limit still works, and so does removing.
  assert.equal(setSubscription(ctx, maya, boardId, "dev", "all").subscription?.level, "all");
  assert.equal(getUsage(ctx, owner, boardId).allowances.find((a) => a.allowance === "subscriptions")!.used, 50);
  setSubscription(ctx, maya, boardId, "dev", null);
  assert.equal(setSubscription(ctx, maya, boardId, "one-too-many", "threads").subscription?.pattern, "one-too-many");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeCtx, human, key } from "./helpers.ts";
import { ensureOwnBoard, createAgent, addAgentToBoard } from "../src/domain/boards.ts";
import { createInvite, redeemInvite } from "../src/domain/invites.ts";
import { startThread, reply, deleteMessage, getThread, listThreads, setLabels } from "../src/domain/conversation.ts";
import { getChanges, getInbox, waitForActivity } from "../src/domain/changes.ts";
import { getUsage, searchMessages, runMaintenance } from "../src/domain/usage.ts";
import { editMessage, labelMessage, react } from "../src/domain/messages.ts";
import { getSchema, listSchemas, registerSchema } from "../src/domain/schemas.ts";
import { getAttachment, readAttachment, uploadAttachment } from "../src/domain/attachments.ts";
import { exportBoard } from "../src/domain/portability.ts";
import { findMentions } from "../src/domain/mentions.ts";
import { actorFromPrincipal, getPrincipal } from "../src/domain/access.ts";
import { ensureProfile, profileActor } from "../src/domain/profiles.ts";
import { OmbError } from "../src/errors.ts";
import type { AppContext } from "../src/context.ts";
import type { Actor } from "../src/domain/model.ts";

async function rejects(p: Promise<unknown> | (() => unknown), code: string): Promise<OmbError> {
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
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const maya = human(ctx, "maya@example.test", "Maya");
  const reader = human(ctx, "reader@example.test", "Rita");
  redeemInvite(ctx, maya, createInvite(ctx, owner, board.id, { audience: "link", role: "contributor" }).url!);
  redeemInvite(ctx, reader, createInvite(ctx, owner, board.id, { audience: "link", role: "reader" }).url!);
  return { ctx, owner, maya, reader, boardId: board.id };
}

const storage = (ctx: AppContext, boardId: string) => (ctx.db.prepare("SELECT storage_bytes AS n FROM boards WHERE id = ?").get(boardId) as { n: number }).n;
const changeTypes = (ctx: AppContext, actor: Actor, boardId: string, cursor: string) => {
  const page = getChanges(ctx, actor, { board_id: boardId, cursor });
  assert.ok("changes" in page);
  return page.changes.map((c) => c.type);
};
const cursorOf = (ctx: AppContext, actor: Actor, boardId: string) => (getChanges(ctx, actor, { board_id: boardId }) as { cursor: string }).cursor;

test("edit: author only, revisions, conflicts, tombstones, storage and a change", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  const t = startThread(ctx, maya, boardId, { title: "Status", body: "step 1 of 5", idempotency_key: key() });
  assert.equal(t.message.revision, 1);
  assert.equal(t.message.edited_at, null);
  const before = storage(ctx, boardId);
  const c0 = cursorOf(ctx, maya, boardId);

  const e1 = editMessage(ctx, maya, t.message.id, { body: "step 2 of 5, tests pass", revision: 1 });
  assert.equal(e1.message.revision, 2);
  assert.ok(e1.message.edited_at);
  assert.equal(e1.message.body, "step 2 of 5, tests pass");
  assert.equal(storage(ctx, boardId), before + Buffer.byteLength("step 2 of 5, tests pass") - Buffer.byteLength("step 1 of 5"));
  assert.deepEqual(changeTypes(ctx, maya, boardId, c0), ["message.edited"]);

  const conflict = await rejects(() => editMessage(ctx, maya, t.message.id, { body: "stale", revision: 1 }), "revision_conflict");
  assert.equal(conflict.details?.revision, 2);
  // The same text again changes nothing.
  assert.equal(editMessage(ctx, maya, t.message.id, { body: "step 2 of 5, tests pass" }).message.revision, 2);
  // Owners can delete anything but edit only their own.
  await rejects(() => editMessage(ctx, owner, t.message.id, { body: "owner rewrite" }), "forbidden");
  assert.equal(getThread(ctx, owner, t.thread.id).messages.find((m) => m.id === t.message.id)!.body, "step 2 of 5, tests pass");

  // Search follows the edit.
  assert.equal(searchMessages(ctx, owner, boardId, "tests").results.length, 1);
  assert.equal(searchMessages(ctx, owner, boardId, "step 1").results.length, 0, "the old text is no longer searchable");

  const del = deleteMessage(ctx, maya, t.message.id);
  assert.equal(del.message.revision, 3, "deleting changes the revision");
  await rejects(() => editMessage(ctx, maya, t.message.id, { body: "back" }), "message_deleted");
});

test("edit: a person edits their agent's messages; edits re-resolve mentions", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  const agentRow = createAgent(ctx, maya, "release-bot");
  addAgentToBoard(ctx, maya, boardId, agentRow.id, "contributor");
  const agent = actorFromPrincipal(getPrincipal(ctx, agentRow.id)!, "agent_token");
  const t = startThread(ctx, agent, boardId, { title: "Deploy", body: "deploying", idempotency_key: key() });
  const edited = editMessage(ctx, maya, t.message.id, { body: "deployed, cc @owner" });
  assert.equal(edited.message.revision, 2);
  assert.deepEqual(edited.message.mentions.map((m) => m.id), [owner.id]);
  assert.equal(edited.mentions_resolved?.[0]?.principal?.id, owner.id);
  const inbox = getInbox(ctx, owner);
  assert.ok(inbox.items.some((i) => i.kind === "mention" && i.message?.id === t.message.id), "a newly mentioned member gets a mention item");
  const removed = editMessage(ctx, maya, t.message.id, { body: "deployed" });
  assert.deepEqual(removed.message.mentions, []);
});

test("profiles: a profile edits only what it wrote, its person edits all of it, and @person/profile mentions it", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  const fx = profileActor(maya, ensureProfile(ctx, getPrincipal(ctx, maya.id)!, "fx"));
  const t = startThread(ctx, fx, boardId, { title: "From fx", body: "fx here", idempotency_key: key() });
  const mine = reply(ctx, maya, t.thread.id, { body: "maya here", idempotency_key: key() });
  assert.equal(editMessage(ctx, maya, t.message.id, { body: "fx here (fixed by maya)" }).message.revision, 2);
  await rejects(() => editMessage(ctx, fx, mine.message.id, { body: "fx rewrites maya" }), "forbidden");
  await rejects(() => editMessage(ctx, owner, t.message.id, { body: "owner rewrites fx" }), "forbidden");
  assert.equal(editMessage(ctx, fx, t.message.id, { body: "fx again" }).message.revision, 3);
  const r = reply(ctx, owner, t.thread.id, { body: "thanks @maya/fx and @maya/nobody", idempotency_key: key() });
  assert.deepEqual(
    r.mentions_resolved?.map((m) => [m.written, m.principal?.id ?? null]),
    [
      ["@maya/fx", fx.id],
      ["@maya/nobody", null],
    ],
  );
  assert.deepEqual(r.message.mentions.map((m) => m.id), [fx.id]);
});

test("reactions: normalized names, counts, me, readers react, tombstones refuse", async () => {
  const { ctx, owner, maya, reader, boardId } = await setup();
  const t = startThread(ctx, owner, boardId, { title: "Ship it?", body: "Ready to ship", idempotency_key: key() });
  const c0 = cursorOf(ctx, owner, boardId);
  react(ctx, maya, t.message.id, { emoji: "+1" });
  react(ctx, reader, t.message.id, { emoji: "👍" });
  react(ctx, reader, t.message.id, { emoji: ":thumbs_up:" });
  const r = react(ctx, owner, t.message.id, { emoji: ":eyes:" });
  assert.deepEqual(
    r.message.reactions.map((x) => [x.emoji, x.count, x.me]),
    [
      ["thumbs_up", 2, false],
      ["eyes", 1, true],
    ],
  );
  const asMaya = getThread(ctx, maya, t.thread.id).messages[0]!;
  assert.equal(asMaya.reactions.find((x) => x.emoji === "thumbs_up")?.me, true);
  assert.equal(asMaya.revision, 1, "reactions leave the revision as it is");
  assert.deepEqual(changeTypes(ctx, owner, boardId, c0), ["reactions.changed", "reactions.changed", "reactions.changed"]);
  react(ctx, maya, t.message.id, { emoji: "thumbs_up", remove: true });
  assert.equal(getThread(ctx, owner, t.thread.id).messages[0]!.reactions.find((x) => x.emoji === "thumbs_up")?.count, 1);
  await rejects(() => react(ctx, maya, t.message.id, { emoji: "<b>" }), "invalid_argument");
  deleteMessage(ctx, owner, t.message.id);
  assert.deepEqual(getThread(ctx, owner, t.thread.id).messages[0]!.reactions, []);
  await rejects(() => react(ctx, maya, t.message.id, { emoji: "eyes" }), "message_deleted");
  const outsider = human(ctx, "x@elsewhere.test");
  await rejects(() => react(ctx, outsider, t.message.id, { emoji: "eyes" }), "not_found");
});

test("labels on messages: root labels are thread labels, conditions, reserved keys, filters", async () => {
  const { ctx, owner, maya, reader, boardId } = await setup();
  const t = startThread(ctx, owner, boardId, { title: "Bug: checkout", body: "times out", labels: { kind: "bug" }, idempotency_key: key() });
  assert.deepEqual(t.message.labels, { kind: "bug" });
  const r1 = reply(ctx, maya, t.thread.id, { body: "fix in review", idempotency_key: key() });
  const other = startThread(ctx, owner, boardId, { title: "Unrelated", body: "nothing to see", idempotency_key: key() });

  const c0 = cursorOf(ctx, owner, boardId);
  const labeled = labelMessage(ctx, maya, r1.message.id, { set: { state: "review" } });
  assert.deepEqual(labeled.message.labels, { state: "review" });
  assert.deepEqual(changeTypes(ctx, owner, boardId, c0), ["labels.changed"], "a reply's labels don't touch the thread");

  // Conditions: the error names the key, never the value.
  const conflict = await rejects(() => labelMessage(ctx, maya, r1.message.id, { set: { state: "fixing" }, if: { state: "open" } }), "label_conflict");
  assert.equal(conflict.details?.key, "state");
  assert.ok(!conflict.message.includes("review"));
  await rejects(() => labelMessage(ctx, maya, r1.message.id, { set: { owner: "fx" }, if: { state: null } }), "label_conflict");
  labelMessage(ctx, maya, r1.message.id, { set: { state: "fixing", owner: "maya" }, if: { state: "review", owner: null } });
  await rejects(() => labelMessage(ctx, maya, r1.message.id, { set: { "board.task": "x" } }), "reserved_label");
  await rejects(() => labelMessage(ctx, maya, r1.message.id, { unset: ["board.task"] }), "reserved_label");
  await rejects(() => setLabels(ctx, maya, t.thread.id, { set: { "board.x": "y" } }), "reserved_label");
  await rejects(() => startThread(ctx, owner, boardId, { title: "x", body: "y", labels: { "board.task": "ready" }, idempotency_key: key() }), "reserved_label");
  await rejects(() => labelMessage(ctx, reader, r1.message.id, { set: { a: "b" } }), "forbidden");

  // The root's labels are the thread's labels, whichever tool sets them.
  const c1 = cursorOf(ctx, owner, boardId);
  labelMessage(ctx, maya, t.message.id, { set: { area: "web" } });
  assert.deepEqual(getThread(ctx, owner, t.thread.id).thread.labels, { kind: "bug", area: "web" });
  assert.deepEqual(changeTypes(ctx, owner, boardId, c1), ["labels.changed", "thread.updated"]);
  setLabels(ctx, owner, t.thread.id, { remove: ["area"] });
  assert.deepEqual(getThread(ctx, owner, t.thread.id).messages.find((m) => m.id === t.message.id)!.labels, { kind: "bug" });

  // Filters match the message or its thread's root.
  const ids = (labels: Record<string, string>) => listThreads(ctx, owner, boardId, { labels }).threads.map((x) => x.id);
  assert.deepEqual(ids({ kind: "bug" }), [t.thread.id]);
  assert.deepEqual(ids({ state: "fixing" }), [t.thread.id]);
  assert.deepEqual(ids({ kind: "bug", state: "fixing" }), [t.thread.id]);
  assert.deepEqual(ids({ state: "review" }), []);
  assert.equal(searchMessages(ctx, owner, boardId, "review", 20, { state: "fixing" }).results.length, 1);
  assert.equal(searchMessages(ctx, owner, boardId, "times", 20, { kind: "bug" }).results.length, 1);
  assert.equal(searchMessages(ctx, owner, boardId, "nothing", 20, { kind: "bug" }).results.length, 0);
  const filtered = getChanges(ctx, owner, { board_id: boardId, cursor: c0, labels: { kind: "bug" } });
  assert.ok("changes" in filtered && filtered.changes.length > 0 && filtered.changes.every((c) => c.thread_id === t.thread.id));
  reply(ctx, owner, other.thread.id, { body: "noise", idempotency_key: key() });
  const after = getChanges(ctx, owner, { board_id: boardId, cursor: filtered.cursor, labels: { kind: "bug" } });
  assert.ok("changes" in after && after.changes.length === 0, "changes on other threads are left out");
  await rejects(() => getChanges(ctx, owner, { inbox: true, labels: { kind: "bug" } }), "invalid_argument");

  // A deleted message loses its labels; the deleted root takes the thread's labels with it.
  deleteMessage(ctx, maya, r1.message.id);
  assert.deepEqual(ids({ state: "fixing" }), []);
  await rejects(() => labelMessage(ctx, maya, r1.message.id, { set: { a: "b" } }), "message_deleted");
  deleteMessage(ctx, owner, t.message.id);
  assert.deepEqual(getThread(ctx, owner, t.thread.id).thread.labels, {});
});

test("a filtered wait skips changes that don't match", async () => {
  const { ctx, owner, boardId } = await setup();
  const a = startThread(ctx, owner, boardId, { title: "Watched", body: "a", labels: { watch: "yes" }, idempotency_key: key() });
  const b = startThread(ctx, owner, boardId, { title: "Other", body: "b", idempotency_key: key() });
  const cursor = cursorOf(ctx, owner, boardId);
  const waiting = waitForActivity(ctx, owner, { board_id: boardId, cursor, labels: { watch: "yes" }, timeout_seconds: 5 });
  setTimeout(() => reply(ctx, owner, b.thread.id, { body: "not this", idempotency_key: key() }), 20);
  setTimeout(() => reply(ctx, owner, a.thread.id, { body: "this one", idempotency_key: key() }), 80);
  const page = await waiting;
  assert.ok("changes" in page);
  assert.deepEqual(page.changes.map((c) => c.message?.body), ["this one"]);
});

test("mentions written in the body: handles, ids, code, unknown and ambiguous stay text", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  assert.deepEqual(
    findMentions("hi @maya and @[p_1], not `@code` or a@b.com\n```\n@block\n```\n@maya again").map((m) => m.written),
    ["@maya", "@[p_1]"],
  );
  const t = startThread(ctx, owner, boardId, { title: "Mentions", body: "@maya please look; @nobody too; `@owner` in code; and @[" + owner.id + "]", idempotency_key: key() });
  assert.deepEqual(
    t.mentions_resolved?.map((m) => [m.written, m.principal?.id ?? null]),
    [
      ["@maya", maya.id],
      ["@nobody", null],
      [`@[${owner.id}]`, owner.id],
    ],
  );
  assert.deepEqual(t.message.mentions.map((m) => m.id).sort(), [maya.id, owner.id].sort());
  assert.ok(getInbox(ctx, maya).items.some((i) => i.kind === "mention" && i.message?.id === t.message.id));
  // Explicit mentions merge with written ones, without duplicates.
  const r = reply(ctx, owner, t.thread.id, { body: "thanks @maya", mentions: [maya.id], idempotency_key: key() });
  assert.deepEqual(r.message.mentions.map((m) => m.id), [maya.id]);
  // No handles, no mentions_resolved.
  assert.equal(reply(ctx, owner, t.thread.id, { body: "plain", idempotency_key: key() }).mentions_resolved, undefined);
});

test("reply after: only while that message is still the newest", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  const t = startThread(ctx, owner, boardId, { title: "Race", body: "who answers first?", idempotency_key: key() });
  const first = reply(ctx, maya, t.thread.id, { body: "me", after: t.message.id, idempotency_key: key() });
  const e = await rejects(() => reply(ctx, owner, t.thread.id, { body: "late", after: t.message.id, idempotency_key: key() }), "newer_message");
  assert.equal(e.details?.newest_message_id, first.message.id);
  reply(ctx, owner, t.thread.id, { body: "after you", after: first.message.id, idempotency_key: key() });
  const elsewhere = startThread(ctx, owner, boardId, { title: "Elsewhere", body: "x", idempotency_key: key() });
  await rejects(() => reply(ctx, owner, t.thread.id, { body: "x", after: elsewhere.message.id, idempotency_key: key() }), "invalid_argument");
});

test("schemas: built-ins, owner registration, immutability, validation and blocks", async () => {
  const { ctx, owner, maya, boardId } = await setup();
  const ids = listSchemas(ctx, maya, boardId).schemas.map((s) => s.id);
  assert.ok(ids.includes("git-commit@1") && ids.includes("deployment@1"));
  const def = { type: "object", required: ["id", "action"], properties: { id: { type: "string" }, action: { enum: ["started", "stopped"] } }, additionalProperties: false };
  await rejects(() => registerSchema(ctx, maya, boardId, { name: "sandbox", version: 1, schema: def }), "forbidden");
  const created = registerSchema(ctx, owner, boardId, { name: "sandbox", version: 1, schema: def, description: "What a sandbox did." });
  assert.equal(created.created, true);
  assert.equal(created.schema.id, "sandbox@1");
  assert.equal(registerSchema(ctx, owner, boardId, { name: "sandbox", version: 1, schema: { ...def } }).created, false);
  await rejects(() => registerSchema(ctx, owner, boardId, { name: "sandbox", version: 1, schema: { ...def, required: ["id"] } }), "schema_immutable");
  await rejects(() => registerSchema(ctx, owner, boardId, { name: "git-commit", version: 1, schema: def }), "schema_immutable");
  await rejects(() => registerSchema(ctx, owner, boardId, { name: "evil", version: 1, schema: { type: "object", properties: { x: { type: "string", pattern: "(a+)+$" } } } }), "invalid_argument");
  await rejects(() => registerSchema(ctx, owner, boardId, { name: "notobject", version: 1, schema: { type: "string" } }), "invalid_argument");
  await rejects(() => registerSchema(ctx, owner, boardId, { name: "broken", version: 1, schema: { type: "object", properties: { x: { type: 12 } } } }), "invalid_argument");
  assert.equal(getSchema(ctx, maya, boardId, "sandbox@1").schema.description, "What a sandbox did.");
  await rejects(() => getSchema(ctx, maya, boardId, "sandbox@2"), "schema_not_found");

  const before = storage(ctx, boardId);
  const t = startThread(ctx, maya, boardId, {
    title: "Sandbox",
    body: "started a sandbox",
    blocks: [
      { schema: "sandbox", version: 1, data: { id: "sbx-1", action: "started" } },
      { schema: "git-commit", version: 1, data: { sha: "a1b2c3d", message: "fix" } },
    ],
    idempotency_key: key(),
  });
  assert.deepEqual(t.message.blocks.map((b) => `${b.schema}@${b.version}`), ["sandbox@1", "git-commit@1"]);
  assert.ok(storage(ctx, boardId) - before > Buffer.byteLength("started a sandbox") + Buffer.byteLength("Sandbox"), "block bytes count toward storage");
  const bad = await rejects(
    () => reply(ctx, maya, t.thread.id, { body: "x", blocks: [{ schema: "sandbox", version: 1, data: { id: "sbx-1", action: "exploded" } }], idempotency_key: key() }),
    "invalid_block",
  );
  assert.equal(bad.details?.schema, "sandbox@1");
  await rejects(() => reply(ctx, maya, t.thread.id, { body: "x", blocks: [{ schema: "nope", version: 1, data: {} }], idempotency_key: key() }), "schema_not_found");
  await rejects(() => reply(ctx, maya, t.thread.id, { body: "x", blocks: [{ schema: "git-commit", version: 1, data: { sha: "not hex" } }], idempotency_key: key() }), "invalid_block");
  // Text and data together must fit in message_bytes.
  const limit = getUsage(ctx, owner, boardId) && ctx.config.limits.message_bytes;
  await rejects(
    () => reply(ctx, maya, t.thread.id, { body: "x".repeat(limit - 10), blocks: [{ schema: "git-commit", version: 1, data: { sha: "a1b2c3d" } }], idempotency_key: key() }),
    "message_too_large",
  );
});

test("attachments: upload, attach, read rules, storage, delete frees, cleanup, export", async () => {
  const { ctx, owner, maya, reader, boardId } = await setup({ attachment_bytes: 64 * 1024 });
  const data = new TextEncoder().encode("trace line 1\ntrace line 2\n");
  const before = storage(ctx, boardId);
  await rejects(uploadAttachment(ctx, reader, boardId, { name: "x.txt", data }), "forbidden");
  const { attachment } = await uploadAttachment(ctx, maya, boardId, { name: "../../trace.txt", type: "text/plain; charset=utf-8", data });
  assert.equal(attachment.name, "trace.txt");
  assert.equal(attachment.type, "text/plain");
  assert.equal(attachment.size, data.byteLength);
  assert.equal(storage(ctx, boardId), before + data.byteLength);
  const usage = getUsage(ctx, owner, boardId).allowances.find((a) => a.allowance === "attachments")!;
  assert.equal(usage.used, data.byteLength);
  assert.equal(usage.limit, 64 * 1024);

  // Until it is attached, only the uploader can read it, and only the uploader can attach it.
  await rejects(readAttachment(ctx, owner, attachment.id), "not_found");
  await rejects(() => startThread(ctx, owner, boardId, { title: "x", body: "y", attachments: [attachment.id], idempotency_key: key() }), "invalid_argument");
  const t = startThread(ctx, maya, boardId, { title: "Trace", body: "see attached", attachments: [attachment.id], idempotency_key: key() });
  assert.deepEqual(t.message.attachments, [attachment]);
  const read = await readAttachment(ctx, reader, attachment.id);
  assert.equal(Buffer.from(read.data).toString(), "trace line 1\ntrace line 2\n");
  const viaMcp = await getAttachment(ctx, reader, attachment.id);
  assert.equal(Buffer.from(viaMcp.data_base64!, "base64").toString(), "trace line 1\ntrace line 2\n");
  assert.ok(viaMcp.url.endsWith(`/api/attachments/${attachment.id}`));
  const outsider = human(ctx, "x@elsewhere.test");
  await rejects(readAttachment(ctx, outsider, attachment.id), "not_found");
  // Anyone who can read it can attach it again.
  const again = reply(ctx, owner, t.thread.id, { body: "same file", attachments: [attachment.id], idempotency_key: key() });
  assert.equal(again.message.attachments.length, 1);
  assert.deepEqual(exportBoard(ctx, owner, boardId).messages.find((m) => m.id === t.message.id)?.attachments, [attachment]);

  // Deleting frees the file once no live message carries it.
  const file = join(ctx.config.dataDir, "attachments", boardId, attachment.id);
  assert.ok(existsSync(file));
  deleteMessage(ctx, maya, t.message.id);
  assert.equal((await readAttachment(ctx, reader, attachment.id)).attachment.id, attachment.id);
  deleteMessage(ctx, owner, again.message.id);
  await rejects(readAttachment(ctx, maya, attachment.id), "not_found");
  assert.equal(getUsage(ctx, owner, boardId).allowances.find((a) => a.allowance === "attachments")!.used, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!existsSync(file), "the stored file is removed");

  // The attachment allowance.
  const big = new Uint8Array(40 * 1024);
  await uploadAttachment(ctx, maya, boardId, { name: "a.bin", data: big });
  const over = await rejects(uploadAttachment(ctx, maya, boardId, { name: "b.bin", data: big }), "quota_exceeded");
  assert.equal(over.details?.allowance, "attachments");
  await rejects(uploadAttachment(ctx, maya, boardId, { name: "huge.bin", data: new Uint8Array(4 * 1024 * 1024 + 1) }), "attachment_too_large");

  // Maintenance removes uploads nobody attached within a day.
  const realNow = ctx.now;
  ctx.now = () => new Date(realNow().getTime() + 2 * 86_400_000);
  runMaintenance(ctx, () => {});
  ctx.now = realNow;
  assert.equal(getUsage(ctx, owner, boardId).allowances.find((a) => a.allowance === "attachments")!.used, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AppContext } from "@openmessageboard/core/context";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/main.ts";
import { OmbError } from "@openmessageboard/core/errors";
import { actorFromPrincipal, getPrincipal } from "@openmessageboard/core/domain/access";
import { addAgentToBoard, createAgent, createNamedBoard, ensureHuman, ensureOwnBoard, mintToken, updateBoard } from "@openmessageboard/core/domain/boards";
import { boardChanges, getInbox } from "@openmessageboard/core/domain/changes";
import { createChannel, createGrant, explainAccess, listChannels, listGrants, revokeGrant, updateGrant } from "@openmessageboard/core/domain/channels";
import { claimTask, getThread, listThreads, reply, setLabels, startThread } from "@openmessageboard/core/domain/conversation";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { searchMessages } from "@openmessageboard/core/domain/usage";
import { covers, specificity } from "@openmessageboard/core/domain/grants";
import { whoami } from "@openmessageboard/core/http/api";
import { ensureProfile, profileActor } from "@openmessageboard/core/domain/profiles";
import type { Actor } from "@openmessageboard/core/domain/model";
import { freePort, human, key, makeCtx } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof OmbError && e.code === c;

async function boardWith(ctx: AppContext) {
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const join = (email: string, name: string, role: "reader" | "contributor") => {
    const a = human(ctx, email, name);
    const inv = createInvite(ctx, owner, board.id, { audience: "email", value: email, role });
    redeemInvite(ctx, a, inv.url!);
    return a;
  };
  const maya = join("maya@example.test", "Maya", "contributor");
  const omar = join("omar@example.test", "Omar", "contributor");
  const rita = join("rita@example.test", "Rita", "reader");
  return { owner, maya, omar, rita, boardId: board.id };
}

const post = (ctx: AppContext, a: Actor, boardId: string, channel: string | undefined, title: string, extra: Record<string, unknown> = {}) =>
  startThread(ctx, a, boardId, { ...(channel ? { channel } : {}), title, body: `${title} body`, idempotency_key: key(), ...extra });

test("patterns: specificity and coverage", () => {
  assert.ok(specificity("a/b") > specificity("a/b/"));
  assert.ok(specificity("a/b/") > specificity("a/"));
  assert.ok(specificity("a/") > specificity("*"));
  assert.ok(covers("a/", "a"));
  assert.ok(covers("a/", "a/b/c"));
  assert.ok(!covers("a/", "ab"));
  assert.ok(covers("a", "a") && !covers("a", "a/b") && !covers("a", "a/"));
  assert.ok(covers("*", "x") && covers("*", "*") && !covers("x/", "*"));
});

test("channels: default general, first post creates a channel, subtree filters", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  const g = post(ctx, owner, boardId, undefined, "Hello");
  assert.equal(g.thread.channel, "general");
  post(ctx, maya, boardId, "www/production", "Deploy failed");
  post(ctx, maya, boardId, "www/preview", "Preview is slow");
  post(ctx, maya, boardId, "wwwx", "Not in the subtree");
  assert.throws(() => post(ctx, maya, boardId, "Bad Channel", "x"), code("invalid_argument"));
  assert.throws(() => post(ctx, maya, boardId, "a/b/c/d/e/f/g", "too deep"), code("invalid_argument"));

  const channels = listChannels(ctx, maya, boardId).channels;
  assert.deepEqual(
    channels.map((c) => [c.path, c.thread_count, c.private]),
    [
      ["general", 1, false],
      ["www/preview", 1, false],
      ["www/production", 1, false],
      ["wwwx", 1, false],
    ],
  );
  assert.deepEqual(channels[0]!.my_permissions, ["read", "post", "react", "label"]);
  const sub = listThreads(ctx, maya, boardId, { channel: "www/" }).threads.map((t) => t.title).sort();
  assert.deepEqual(sub, ["Deploy failed", "Preview is slow"]);
  assert.deepEqual(listThreads(ctx, maya, boardId, { channel: "www/production" }).threads.map((t) => t.title), ["Deploy failed"]);
  assert.equal(searchMessages(ctx, maya, boardId, "body", 20, "www/").results.length, 2);

  const created = createChannel(ctx, maya, boardId, { path: "dev/alerts" });
  assert.equal(created.created, true);
  assert.equal(created.channel.thread_count, 0);
  assert.equal(created.channel.last_activity_at, null);
  assert.equal(createChannel(ctx, maya, boardId, { path: "dev/alerts" }).created, false);
  // Changes filtered by channel only carry thread changes in that subtree.
  const page = boardChanges(ctx, maya, boardId, Buffer.from(JSON.stringify({ v: 1, k: "b", id: boardId, s: 0 })).toString("base64url"), 100, undefined, "www/");
  assert.ok(page.changes.length > 0 && page.changes.every((c) => c.thread?.channel.startsWith("www/")));
});

test("private channel: hidden from members who weren't granted it everywhere they could read", async () => {
  const ctx = await makeCtx();
  const { owner, maya, omar, rita, boardId } = await boardWith(ctx);
  const start = boardChanges(ctx, maya, boardId, undefined).cursor;
  const made = createChannel(ctx, owner, boardId, { path: "security", private: true });
  assert.equal(made.created, true);
  assert.equal(made.channel.private, true);
  assert.equal(made.grants.length, 2);
  // Maya can't create one herself: she has no manage.
  assert.throws(() => createChannel(ctx, maya, boardId, { path: "mine", private: true }), code("forbidden"));
  // Existing channel or grant: refused.
  post(ctx, maya, boardId, "ops/alerts", "Disk full");
  assert.throws(() => createChannel(ctx, owner, boardId, { path: "ops", private: true }), (e) => e instanceof OmbError && e.code === "conflict" && e.details?.reason === "channel_exists");
  createGrant(ctx, owner, boardId, { principals: [{ kind: "readers" }], can: { "audit/": ["read"] } });
  assert.throws(() => createChannel(ctx, owner, boardId, { path: "audit", private: true }), (e) => e instanceof OmbError && e.code === "conflict" && e.details?.reason === "channel_granted");
  // A grant at a broader pattern doesn't stop a private channel under it: the more specific grants decide there.
  assert.equal(createChannel(ctx, owner, boardId, { path: "security/inner", private: true }).created, true);

  const mayaId = maya.id;
  const secret = post(ctx, owner, boardId, "security/incidents", "Leaked key", { mentions: [mayaId] });
  post(ctx, owner, boardId, "general", "Lunch");

  // Maya sees neither the channel, the thread, the change, the search hit nor the mention.
  assert.deepEqual(listChannels(ctx, maya, boardId).channels.map((c) => c.path).sort(), ["general", "ops/alerts"]);
  assert.deepEqual(listThreads(ctx, maya, boardId).threads.map((t) => t.title).sort(), ["Disk full", "Lunch"]);
  assert.throws(() => getThread(ctx, maya, secret.thread.id), code("not_found"));
  assert.throws(() => reply(ctx, maya, secret.thread.id, { body: "hi", idempotency_key: key() }), code("not_found"));
  assert.throws(() => reply(ctx, rita, secret.thread.id, { body: "hi", idempotency_key: key() }), code("not_found"));
  assert.throws(() => setLabels(ctx, maya, secret.thread.id, { set: { a: "b" } }), code("not_found"));
  const changes = boardChanges(ctx, maya, boardId, start).changes;
  assert.ok(changes.every((c) => c.thread?.channel !== "security/incidents"));
  assert.ok(changes.some((c) => c.thread?.title === "Lunch"));
  assert.equal(searchMessages(ctx, maya, boardId, "Leaked").results.length, 0);
  assert.equal(getInbox(ctx, maya).items.filter((i) => i.thread_id === secret.thread.id).length, 0);
  assert.throws(() => post(ctx, maya, boardId, "security/x", "sneak"), code("forbidden"));
  // The owner, who created it, reads everything.
  assert.equal(getThread(ctx, owner, secret.thread.id).thread.title, "Leaked key");

  // Let Omar in by adding him to the creator's grant; he sees it, Maya still doesn't.
  const mine = made.grants.find((g) => g.principals.some((p) => p.kind === "member"))!;
  updateGrant(ctx, owner, mine.id, { add: [{ kind: "member", principal_id: omar.id }] });
  assert.equal(getThread(ctx, omar, secret.thread.id).thread.id, secret.thread.id);
  assert.throws(() => getThread(ctx, maya, secret.thread.id), code("not_found"));
  const ex = explainAccess(ctx, owner, boardId, "security/incidents", maya.id);
  assert.deepEqual(ex.can, []);
  assert.equal(ex.pattern, "security/");
  assert.equal(ex.level, "everyone");
  const omarEx = explainAccess(ctx, omar, boardId, "security/incidents");
  assert.equal(omarEx.level, "member");
  assert.deepEqual(omarEx.can, ["read", "post", "react", "label", "manage"]);
  assert.deepEqual(explainAccess(ctx, owner, boardId, "security/incidents", rita.id).can, []);
  // Explaining someone else needs manage at *.
  assert.throws(() => explainAccess(ctx, omar, boardId, "general", maya.id), code("forbidden"));
  // Revoking the closing grant reopens the channel; Maya's existing mention reappears.
  const closed = made.grants.find((g) => g.principals.some((p) => p.kind === "everyone"))!;
  revokeGrant(ctx, owner, closed.id);
  assert.equal(getThread(ctx, maya, secret.thread.id).thread.id, secret.thread.id);
});

test("grants: most specific pattern, closest principal, ties add up, role caps", async () => {
  const ctx = await makeCtx();
  const { owner, maya, omar, rita, boardId } = await boardWith(ctx);
  // Close everything to contributors except read; Maya gets everything at *; readers can't be raised to post.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "contributors" }], can: { "*": ["read"] } });
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: maya.id }], can: { "*": "all" } });
  createGrant(ctx, owner, boardId, { principals: [{ kind: "readers" }], can: { "*": "all" } });
  post(ctx, owner, boardId, "security", "secret task", { task: true });
  assert.throws(() => post(ctx, omar, boardId, "dev", "nope"), code("forbidden"));
  const t = post(ctx, maya, boardId, "dev", "yes");
  assert.throws(() => post(ctx, rita, boardId, "dev", "readers never post"), code("forbidden"));
  assert.deepEqual(explainAccess(ctx, owner, boardId, "dev", rita.id).can, ["read", "react"]);
  // A more specific pattern decides first: "security/" closed to everyone beats Maya's "*".
  createGrant(ctx, owner, boardId, { principals: [{ kind: "everyone" }], can: { "security/": "none" } });
  assert.throws(() => post(ctx, maya, boardId, "security", "blocked"), code("forbidden"));
  // Ties at the same pattern and level add up.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: omar.id }], can: { dev: ["read"] } });
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: omar.id }], can: { dev: ["post"] } });
  reply(ctx, omar, t.thread.id, { body: "now I can", idempotency_key: key() });
  assert.throws(() => setLabels(ctx, omar, t.thread.id, { set: { a: "b" } }), code("forbidden"));
  const ex = explainAccess(ctx, omar, boardId, "dev");
  assert.equal(ex.grant_ids.length, 2);
  assert.deepEqual(ex.can, ["read", "post"]);
  // Maya was given manage at "*": she can manage grants but can't grant more than she has.
  createGrant(ctx, maya, boardId, { principals: [{ kind: "member", principal_id: omar.id }], can: { "ops/": ["read", "post"] } });
  assert.throws(() => createGrant(ctx, maya, boardId, { principals: [{ kind: "everyone" }], can: { "security/": ["read"] } }), code("forbidden"));
  assert.throws(() => createGrant(ctx, omar, boardId, { principals: [{ kind: "everyone" }], can: { "*": ["read"] } }), code("forbidden"));
  // Listing shows the grants you manage: every grant for the owner, the ones Maya can manage for her, none for Omar.
  assert.equal(listGrants(ctx, owner, boardId).grants.length, 7);
  assert.ok(listGrants(ctx, maya, boardId).grants.every((g) => !Object.keys(g.can).includes("security/")));
  assert.equal(listGrants(ctx, omar, boardId).grants.length, 0);
  // Members named in grants must be on the board.
  const stranger = human(ctx, "stranger@example.test");
  assert.throws(() => createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: stranger.id }], can: { "*": "all" } }), code("invalid_argument"));
  // Claiming the next open task skips channels you can't post in; grants apply to the owner too.
  assert.throws(() => post(ctx, owner, boardId, "security", "closed to the owner too"), code("forbidden"));
  await assert.rejects(claimTask(ctx, omar, { board_id: boardId }), code("no_task_available"));
});

test("agents: reached by their person's grants, capped by what their person can do", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  const a = createAgent(ctx, maya, "release-agent");
  addAgentToBoard(ctx, maya, boardId, a.id, "contributor");
  const agent: Actor = actorFromPrincipal(ctx.db.prepare("SELECT * FROM principals WHERE id = ?").get(a.id) as never, "agent_token");
  const made = createChannel(ctx, owner, boardId, { path: "releases", private: true });
  const mine = made.grants.find((g) => g.principals.some((p) => p.kind === "member"))!;
  assert.throws(() => post(ctx, agent, boardId, "releases", "x"), code("forbidden"));
  updateGrant(ctx, owner, mine.id, { add: [{ kind: "member", principal_id: maya.id }] });
  // Maya's grant reaches her agent.
  const t = post(ctx, agent, boardId, "releases", "Build 812 is green");
  assert.equal(t.thread.channel, "releases");
  // A grant naming the agent itself decides over its person's grant.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: a.id }], can: { "releases/": ["read"] } });
  assert.throws(() => reply(ctx, agent, t.thread.id, { body: "x", idempotency_key: key() }), code("forbidden"));
  const ex = explainAccess(ctx, owner, boardId, "releases", a.id);
  assert.equal(ex.level, "agent");
  assert.deepEqual(ex.person_cap, ["read", "post", "react", "label", "manage"]);
  assert.deepEqual(ex.can, ["read"]);
  // An agent never exceeds its person: give the agent everything in "ops" but close it to Maya.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: a.id }], can: { ops: "all" } });
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: maya.id }], can: { ops: "none" } });
  assert.throws(() => post(ctx, agent, boardId, "ops", "x"), code("forbidden"));
});

test("profiles resolve as their person; scoped tokens are capped by their can and boards", async () => {
  const ctx = await makeCtx();
  const { owner, maya, boardId } = await boardWith(ctx);
  const fx = profileActor(maya, ensureProfile(ctx, getPrincipal(ctx, maya.id)!, "fx"));
  const made = createChannel(ctx, owner, boardId, { path: "security", private: true });
  const secret = post(ctx, owner, boardId, "security", "Rotate keys");
  assert.throws(() => getThread(ctx, fx, secret.thread.id), code("not_found"));
  assert.throws(() => createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: fx.id }], can: { "*": "all" } }), code("invalid_argument"));
  const mine = made.grants.find((g) => g.principals.some((p) => p.kind === "member"))!;
  updateGrant(ctx, owner, mine.id, { add: [{ kind: "member", principal_id: maya.id }] });
  // Maya's grant is her profile's grant.
  assert.equal(getThread(ctx, fx, secret.thread.id).thread.id, secret.thread.id);
  const ex = explainAccess(ctx, owner, boardId, "security", fx.id);
  assert.equal(ex.level, "member");
  assert.equal(ex.person_cap, null);
  // A read-only token reads where its holder can, posts nowhere and manages nothing.
  const readOnly: Actor = { ...maya, scope: { boards: null, can: ["read"], profile: null, expires_at: null } };
  assert.deepEqual(listChannels(ctx, readOnly, boardId).channels.find((c) => c.path === "security")?.my_permissions, ["read"]);
  assert.throws(() => post(ctx, readOnly, boardId, "general", "nope"), code("forbidden"));
  assert.throws(() => createChannel(ctx, readOnly, boardId, { path: "mine", private: true }), code("forbidden"));
  // Even the owner's full scoped token can't manage grants or create private channels.
  const ownerToken: Actor = { ...owner, scope: { boards: null, can: ["read", "post", "react", "label"], profile: null, expires_at: null } };
  assert.throws(() => createChannel(ctx, ownerToken, boardId, { path: "ops", private: true }), code("forbidden"));
  assert.throws(() => createGrant(ctx, ownerToken, boardId, { principals: [{ kind: "everyone" }], can: { "*": ["read"] } }), code("forbidden"));
  assert.equal(listGrants(ctx, ownerToken, boardId).grants.length, 0);
  // A token scoped to other boards sees nothing here.
  const elsewhere: Actor = { ...maya, scope: { boards: ["b_other"], can: ["read"], profile: null, expires_at: null } };
  assert.throws(() => listChannels(ctx, elsewhere, boardId), code("not_found"));
});

test("named boards: plan limit, unique names, whoami lists every owned board", async () => {
  const ctx = await makeCtx({}, { boards_owned: 3 });
  const owner = human(ctx, "owner@example.test", "Owner");
  const info = { spec_version: "0.1" } as never;
  const first = whoami(ctx, owner, info, true);
  assert.equal(first.owned_board?.is_personal, true);
  const sec = createNamedBoard(ctx, owner, "Security");
  assert.equal(sec.is_personal, false);
  assert.equal(sec.my_role, "owner");
  assert.throws(() => createNamedBoard(ctx, owner, "security"), (e) => e instanceof OmbError && e.code === "conflict" && e.details?.reason === "board_name_taken");
  assert.throws(() => updateBoard(ctx, owner, first.owned_board!.id, { name: "SECURITY" }), code("conflict"));
  createNamedBoard(ctx, owner, "Ops");
  assert.throws(() => createNamedBoard(ctx, owner, "Fourth"), (e) => e instanceof OmbError && e.code === "quota_exceeded" && e.details?.allowance === "boards_owned");
  const me = whoami(ctx, owner, info, true);
  assert.equal(me.owned_board?.id, first.owned_board?.id);
  assert.deepEqual(me.owned_boards.map((b) => b.name), [first.owned_board!.name, "Security", "Ops"]);
  // Base plan default: one board, already used by the personal board.
  const base = await makeCtx();
  const p = human(base, "p@example.test");
  whoami(base, p, info, true);
  assert.throws(() => createNamedBoard(base, p, "Another"), code("quota_exceeded"));
});

test("listen: a member who loses read access to a channel stops getting its updates", async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-ch-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  const running = await startServer(config, { features: {} });
  try {
    const ctx = running.ctx;
    const ownerRow = ensureHuman(ctx, { email: "owner@example.test", displayName: "Owner" });
    const mayaRow = ensureHuman(ctx, { email: "maya@example.test", displayName: "Maya" });
    const owner = actorFromPrincipal(ownerRow, "test_token");
    const maya = actorFromPrincipal(mayaRow, "test_token");
    const board = ensureOwnBoard(ctx, owner, { create: true })!;
    redeemInvite(ctx, maya, createInvite(ctx, owner, board.id, { audience: "email", value: "maya@example.test", role: "contributor" }).url!);
    const ops = post(ctx, owner, board.id, "ops", "Ops thread");
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.publicUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mintToken(ctx, mayaRow.id, "test").token}` } } }),
    );
    const updates: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (n) => void updates.push(n.params.uri));
    const boardUri = `${config.publicUrl}/b/${board.id}`;
    const sub = await client.listen({ resourceSubscriptions: [boardUri, ops.thread.url] });
    assert.deepEqual(sub.honoredFilter.resourceSubscriptions, [boardUri, ops.thread.url]);
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 40 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    reply(ctx, owner, ops.thread.id, { body: "visible", idempotency_key: key() });
    await waitFor(() => updates.length >= 2);
    assert.deepEqual([...updates].sort(), [boardUri, ops.thread.url].sort());
    // Close ops to everyone but the owner: the thread URI is dropped and ops changes stop.
    createGrant(ctx, owner, board.id, { principals: [{ kind: "everyone" }], can: { "ops/": "none" } });
    createGrant(ctx, owner, board.id, { principals: [{ kind: "member", principal_id: owner.id }], can: { "ops/": "all" } });
    await new Promise((r) => setTimeout(r, 400));
    updates.length = 0;
    reply(ctx, owner, ops.thread.id, { body: "hidden", idempotency_key: key() });
    post(ctx, owner, board.id, "ops", "Hidden thread");
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(updates, []);
    // Changes elsewhere still arrive.
    post(ctx, owner, board.id, "general", "Visible thread");
    await waitFor(() => updates.length >= 1);
    assert.deepEqual(updates, [boardUri]);
    await sub.close();
    await client.close();
  } finally {
    await running.stop();
  }
});

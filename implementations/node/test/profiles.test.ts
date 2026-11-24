import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makeCtx, human, key, freePort } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { ensureOwnBoard, createAgent, addAgentToBoard, ensureHuman, mintToken, listMemberships, updateMember } from "@openmessageboard/core/domain/boards";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { startThread, reply, deleteMessage, listThreads, claimTask } from "@openmessageboard/core/domain/conversation";
import { getInbox } from "@openmessageboard/core/domain/changes";
import { actorFromPrincipal, getPrincipal } from "@openmessageboard/core/domain/access";
import { applyProfileHeader, ensureProfile, listActors } from "@openmessageboard/core/domain/profiles";
import { createAgentToken, createPersonalToken, createScopedToken } from "@openmessageboard/core/domain/tokens";
import { OmbError } from "@openmessageboard/core/errors";
import type { AppContext } from "@openmessageboard/core/context";
import type { Actor } from "@openmessageboard/core/domain/model";

async function rejects(fn: () => unknown, code: string) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof OmbError, `expected OmbError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}`);
}

function asProfile(ctx: AppContext, person: Actor, name: string): Actor {
  return applyProfileHeader(ctx, person, name);
}

describe("profiles", () => {
  test("a profile writes with its person's access, shows via the person, and needs no invite", async () => {
    const ctx = await makeCtx();
    const owner = human(ctx, "owner@example.test", "Owner");
    const board = ensureOwnBoard(ctx, owner, { create: true })!;
    const ada = human(ctx, "ada@example.test", "Ada");
    redeemInvite(ctx, ada, createInvite(ctx, owner, board.id, { audience: "email", value: "ada@example.test", role: "contributor" }).url!);

    const fx = asProfile(ctx, ada, "fx");
    assert.equal(fx.kind, "agent");
    assert.equal(fx.ownerId, ada.id);
    const { message } = startThread(ctx, fx, board.id, { title: "From fx", body: "hello", idempotency_key: key() });
    assert.equal(message.author.id, fx.id);
    assert.equal(message.author.display_name, "fx");
    assert.deepEqual(message.author.via, { id: ada.id, display_name: "Ada" });
    // Same profile, any case: one principal.
    assert.equal(asProfile(ctx, ada, "FX").id, fx.id);
    // It sees the person's boards and role, and takes no seat.
    assert.deepEqual(
      listMemberships(ctx, fx).map((m) => [m.board_id, m.role]),
      listMemberships(ctx, ada).map((m) => [m.board_id, m.role]),
    );
    assert.equal((ctx.db.prepare("SELECT COUNT(*) n FROM memberships WHERE principal_id = ?").get(fx.id) as { n: number }).n, 0);

    const actors = listActors(ctx, owner, board.id);
    const a = actors.find((x) => x.id === fx.id)!;
    assert.equal(a.kind, "profile");
    assert.equal(a.handle, `${actors.find((x) => x.id === ada.id)!.handle}/fx`);
    assert.equal(a.is_member, true);
    assert.deepEqual(a.via, { id: ada.id, display_name: "Ada" });

    // A reader's profile is a reader; removing the person ends the profile's access.
    updateMember(ctx, owner, board.id, ada.id, { role: "reader" });
    await rejects(() => startThread(ctx, fx, board.id, { title: "x", body: "y", idempotency_key: key() }), "forbidden");
    ctx.db.prepare("DELETE FROM memberships WHERE board_id = ? AND principal_id = ?").run(board.id, ada.id);
    await rejects(() => listThreads(ctx, fx, board.id), "not_found");
    assert.equal(listActors(ctx, owner, board.id).find((x) => x.id === fx.id)!.is_member, false);
  });

  test("a profile changes only what it wrote; its person changes what any profile wrote", async () => {
    const ctx = await makeCtx();
    const ada = human(ctx, "ada@example.test", "Ada");
    const board = ensureOwnBoard(ctx, ada, { create: true })!;
    const fx = asProfile(ctx, ada, "fx");
    const codex = asProfile(ctx, ada, "codex");
    const t = startThread(ctx, ada, board.id, { title: "t", body: "by ada", idempotency_key: key() });
    const byFx = reply(ctx, fx, t.thread.id, { body: "by fx", idempotency_key: key() }).message;
    // Even with the person's owner role, a profile can't delete the person's message or another profile's.
    await rejects(() => deleteMessage(ctx, fx, t.message.id), "forbidden");
    await rejects(() => deleteMessage(ctx, codex, byFx.id), "forbidden");
    assert.equal(deleteMessage(ctx, fx, byFx.id).message.deleted, true);
    const byCodex = reply(ctx, codex, t.thread.id, { body: "by codex", idempotency_key: key() }).message;
    assert.equal(deleteMessage(ctx, ada, byCodex.id).message.deleted, true);
  });

  test("profiles have their own mentions and inbox; a person's ID covers their profiles in filters", async () => {
    const ctx = await makeCtx();
    const ada = human(ctx, "ada@example.test", "Ada");
    const board = ensureOwnBoard(ctx, ada, { create: true })!;
    const fx = asProfile(ctx, ada, "fx");
    const task = startThread(ctx, ada, board.id, { title: "task", body: "do it", task: true, idempotency_key: key() });
    claimTask(ctx, fx, { thread_id: task.thread.id });
    startThread(ctx, ada, board.id, { title: "ping", body: "@ada/fx look", mentions: [fx.id], idempotency_key: key() });
    assert.equal(getInbox(ctx, fx).items.filter((i) => i.kind === "mention").length, 1);
    assert.deepEqual(
      listThreads(ctx, ada, board.id, { assignee: ada.id }).threads.map((x) => x.id),
      [task.thread.id],
    );
    assert.equal(listThreads(ctx, ada, board.id, { assignee: "me" }).threads.length, 1);
  });

  test("agents can't write as a profile; names are validated; profiles can't redeem invites", async () => {
    const ctx = await makeCtx();
    const owner = human(ctx, "owner@example.test", "Owner");
    const board = ensureOwnBoard(ctx, owner, { create: true })!;
    const maya = human(ctx, "maya@example.test", "Maya");
    const agent = createAgent(ctx, maya, "release-agent");
    const agentActor = actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
    await rejects(() => applyProfileHeader(ctx, agentActor, "fx"), "forbidden");
    await rejects(() => applyProfileHeader(ctx, maya, "1fx"), "invalid_argument");
    await rejects(() => applyProfileHeader(ctx, maya, "a".repeat(33)), "invalid_argument");
    await rejects(() => applyProfileHeader(ctx, maya, "has space"), "invalid_argument");
    const fx = asProfile(ctx, maya, "fx");
    const link = createInvite(ctx, owner, board.id, { audience: "link", role: "reader" });
    await rejects(() => redeemInvite(ctx, fx, link.url!), "invite_not_eligible");
    // A profile is not one of the person's agents.
    await rejects(() => addAgentToBoard(ctx, owner, board.id, fx.id, "reader"), "not_found");
  });
});

describe("scoped tokens", () => {
  test("read-only, board scope, profile and expiry are validated and stored", async () => {
    const ctx = await makeCtx();
    const ada = human(ctx, "ada@example.test", "Ada");
    const board = ensureOwnBoard(ctx, ada, { create: true })!;
    const other = human(ctx, "other@example.test");
    const otherBoard = ensureOwnBoard(ctx, other, { create: true })!;

    const t = createScopedToken(ctx, ada, { boards: [board.id], can: ["read"], expires_in_seconds: 600 });
    assert.deepEqual(t.scope.boards, [board.id]);
    assert.deepEqual(t.scope.can, ["read"]);
    assert.ok(Date.parse(t.scope.expires_at!) > Date.now());
    await rejects(() => createScopedToken(ctx, ada, { boards: [otherBoard.id] }), "not_found");
    await rejects(() => createScopedToken(ctx, ada, { can: ["read", "post"] }), "invalid_argument");
    await rejects(() => createScopedToken(ctx, ada, { expires_in_seconds: 86_401 }), "invalid_argument");
    const agent = createAgent(ctx, ada, "bot");
    await rejects(() => createAgentToken(ctx, ada, agent.id, { profile: "fx" }), "invalid_argument");
    const agentActor = actorFromPrincipal(getPrincipal(ctx, agent.id)!, "agent_token");
    await rejects(() => createScopedToken(ctx, agentActor, {}), "forbidden");
    // Unscoped personal tokens stay as they were.
    assert.equal(createPersonalToken(ctx, ada, { label: "cli" }).scope, undefined);
    // As a profile, the token writes as that profile and can't name another.
    const fx = asProfile(ctx, ada, "fx");
    assert.equal(createScopedToken(ctx, fx, {}).scope.profile, "fx");
    await rejects(() => createScopedToken(ctx, fx, { profile: "codex" }), "forbidden");
  });
});

describe("profiles and scoped tokens over HTTP", () => {
  let running: Running;
  let base: string;
  let adaToken: string;
  let mayaAgentToken: string;
  let adaBoard: string;
  let mayaBoard: string;

  before(async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "omb-profiles-"));
    const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
    running = await startServer(config, { features: {} });
    base = config.publicUrl;
    const ctx = running.ctx;
    const ada = ensureHuman(ctx, { email: "ada@example.test", displayName: "Ada" });
    const maya = ensureHuman(ctx, { email: "maya@example.test", displayName: "Maya" });
    adaToken = mintToken(ctx, ada.id, "test").token;
    adaBoard = ensureOwnBoard(ctx, actorFromPrincipal(ada, "test_token"), { create: true })!.id;
    mayaBoard = ensureOwnBoard(ctx, actorFromPrincipal(maya, "test_token"), { create: true })!.id;
    const mayaActor = actorFromPrincipal(maya, "test_token");
    redeemInvite(ctx, actorFromPrincipal(ada, "test_token"), createInvite(ctx, mayaActor, mayaBoard, { audience: "email", value: "ada@example.test", role: "contributor" }).url!);
    const agent = createAgent(ctx, mayaActor, "release-agent");
    mayaAgentToken = mintToken(ctx, agent.id, "agent").token;
    ensureProfile(ctx, ada, "seed");
  });

  after(async () => {
    await running.stop();
  });

  async function connect(token: string, profile?: string): Promise<Client> {
    const client = new Client({ name: "profiles-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (profile) headers["OMB-Profile"] = profile;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    return client;
  }

  async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
    if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { body: r.structuredContent });
    return r.structuredContent as T;
  }

  async function code(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: { error?: { code: string } } };
    assert.equal(r.isError, true, `${name} should fail`);
    return r.structuredContent!.error!.code;
  }

  const api = (token: string, path: string, init: RequestInit = {}, profile?: string) =>
    fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(profile ? { "OMB-Profile": profile } : {}) } });

  test("the OMB-Profile header writes as a profile; agents with the header are refused", async () => {
    const fx = await connect(adaToken, "fixer-1");
    const me = await call<{ principal: { kind: string; profile: string; owner: { display_name: string } }; owned_board: { id: string } | null; memberships: { board_id: string }[] }>(fx, "whoami");
    assert.equal(me.principal.kind, "agent");
    assert.equal(me.principal.profile, "fixer-1");
    assert.equal(me.principal.owner.display_name, "Ada");
    assert.equal(me.owned_board?.id, adaBoard);
    assert.ok(me.memberships.some((m) => m.board_id === mayaBoard));
    const started = await call<{ message: { author: { display_name: string; via: { display_name: string } } } }>(fx, "start_thread", {
      board_id: mayaBoard,
      title: "from a profile",
      body: "fixer-1 via Ada",
      idempotency_key: key(),
    });
    assert.equal(started.message.author.display_name, "fixer-1");
    assert.equal(started.message.author.via.display_name, "Ada");
    const actors = await call<{ actors: { kind: string; handle: string }[] }>(fx, "list_actors", { board_id: mayaBoard });
    assert.ok(actors.actors.some((a) => a.kind === "profile" && a.handle.endsWith("/fixer-1")));
    await fx.close();

    const refused = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mayaAgentToken}`, "OMB-Profile": "fx", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(refused.status, 403);
    const bad = await api(adaToken, "/api/me", {}, "not a name");
    assert.equal(bad.status, 400);
  });

  test("scoped tokens: read-only can't post, board scope hides other boards, expiry rejects, profile is fixed", async () => {
    const ada = await connect(adaToken);
    const ro = await call<{ token: string }>(ada, "create_scoped_token", { boards: [mayaBoard], can: ["read"], expires_in_seconds: 600 });
    const scoped = await connect(ro.token);
    const me = await call<{ memberships: { board_id: string; role: string }[]; owned_board: unknown; principal: { scope: { can: string[] } } }>(scoped, "whoami");
    assert.deepEqual(me.memberships.map((m) => [m.board_id, m.role]), [[mayaBoard, "reader"]]);
    assert.equal(me.owned_board, null);
    assert.deepEqual(me.principal.scope.can, ["read"]);
    await call(scoped, "list_threads", { board_id: mayaBoard });
    assert.equal(await code(scoped, "start_thread", { board_id: mayaBoard, title: "x", body: "y", idempotency_key: key() }), "forbidden");
    assert.equal(await code(scoped, "list_threads", { board_id: adaBoard }), "not_found");
    assert.equal(await code(scoped, "create_scoped_token", {}), "forbidden");
    assert.equal(await code(scoped, "create_invite", { board_id: mayaBoard, audience: "link", role: "reader" }), "forbidden");
    // The web API is closed to it except conversation routes.
    assert.equal((await api(ro.token, "/api/tokens", { method: "POST", body: "{}" })).status, 403);
    assert.equal((await api(ro.token, "/api/agents")).status, 403);
    assert.equal((await api(ro.token, `/api/boards/${mayaBoard}/threads`)).status, 200);
    assert.equal((await api(ro.token, `/api/boards/${adaBoard}/threads`)).status, 404);
    await scoped.close();

    const asFx = await call<{ token: string; scope: { profile: string } }>(ada, "create_scoped_token", { profile: "fx", expires_in_seconds: 600 });
    assert.equal(asFx.scope.profile, "fx");
    const fx = await connect(asFx.token);
    const posted = await call<{ message: { author: { display_name: string } } }>(fx, "start_thread", { board_id: adaBoard, title: "t", body: "b", idempotency_key: key() });
    assert.equal(posted.message.author.display_name, "fx");
    await fx.close();
    assert.equal((await api(asFx.token, "/api/me", {}, "codex")).status, 403);
    assert.equal((await api(asFx.token, "/api/me", {}, "FX")).status, 200);

    const short = await call<{ token: string }>(ada, "create_scoped_token", { expires_in_seconds: 1 });
    assert.equal((await api(short.token, "/api/me")).status, 200);
    await new Promise((r) => setTimeout(r, 1200));
    const expired = await api(short.token, "/api/me");
    assert.equal(expired.status, 401);

    // Personal tokens list their scope and expiry; expired ones drop out.
    const list = (await (await api(adaToken, "/api/tokens")).json()) as { tokens: { id: string; scope: { can: string[] } | null; expires_at: string | null }[] };
    assert.ok(list.tokens.some((t) => t.scope?.can.length === 1 && t.expires_at));
    await ada.close();
  });

  test("POST /api/tokens takes a scope; a person's own token with --as-style header still works", async () => {
    const res = await api(adaToken, "/api/tokens", { method: "POST", body: JSON.stringify({ label: "ro", boards: [adaBoard], can: ["read"], expires_in_seconds: 3600 }) });
    assert.equal(res.status, 200);
    const created = (await res.json()) as { token: string; scope: { boards: string[] } };
    assert.deepEqual(created.scope.boards, [adaBoard]);
    const empty = await api(adaToken, "/api/tokens", { method: "POST" });
    assert.equal(empty.status, 200);
    assert.equal(((await empty.json()) as { scope?: unknown }).scope, undefined);
    const threads = await api(adaToken, `/api/boards/${adaBoard}/threads`, {}, "fixer-2");
    assert.equal(threads.status, 200);
  });
});

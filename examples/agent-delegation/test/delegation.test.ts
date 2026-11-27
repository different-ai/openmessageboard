/**
 * The gateway in front of the unmodified reference server, exercised over HTTP only. Each test is one guarantee
 * or one thing an attacker would try (proposal 0006 §Security considerations uses the same numbering).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT, decodeJwt } from "jose";
import { loadConfig } from "@openmessageboard/server-node/src/config.ts";
import { startServer, type Running } from "@openmessageboard/server-node/src/main.ts";
import { actorFromPrincipal } from "@openmessageboard/core/domain/access";
import { createAgent, ensureHuman, ensureOwnBoard, mintToken, removeMember } from "@openmessageboard/core/domain/boards";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { DETAIL_TYPE, ExchangeError, actorToken, delegationAssertion, dpopFetch, dpopProof, exchange, newAgentKey, type Access, type AgentKey, type Delegated, type Permission } from "../src/agent.ts";
import { MAX_SUB_AGENTS, createGateway, type Gateway } from "../src/gateway.ts";

const ALL: Permission[] = ["read", "post", "react", "label"];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let board: Running;
let gateway: Gateway;
let gatewayServer: ServerType;
let gw: string; // the gateway's base URL
let boardId: string;
let mayaId: string;
let mayaToken: string;
let ownerToken: string;
let n = 0;
const key = () => `k-${++n}`;

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-delegation-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  board = await startServer(config, { features: {} });
  const ctx = board.ctx;
  const owner = ensureHuman(ctx, { email: "owner@example.test", displayName: "Owner" });
  const maya = ensureHuman(ctx, { email: "maya@example.test", displayName: "Maya" });
  boardId = ensureOwnBoard(ctx, actorFromPrincipal(owner, "test_token"), { create: true })!.id;
  redeemInvite(ctx, actorFromPrincipal(maya, "test_token"), createInvite(ctx, actorFromPrincipal(owner, "test_token"), boardId, { audience: "email", value: "maya@example.test", role: "contributor" }).url!);
  mayaId = maya.id;
  mayaToken = mintToken(ctx, maya.id, "test").token;
  ownerToken = mintToken(ctx, owner.id, "test").token;

  const gwPort = await freePort();
  gw = `http://127.0.0.1:${gwPort}`;
  gateway = await createGateway({ upstream: config.publicUrl, publicUrl: gw });
  gatewayServer = serve({ fetch: gateway.fetch, port: gwPort, hostname: "127.0.0.1" });
  await new Promise<void>((r) => gatewayServer.once("listening", () => r()));
});

after(async () => {
  const s = gatewayServer as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void };
  const closed = new Promise<void>((r) => s.close(() => r()));
  s.closeAllConnections?.();
  await closed;
  await board.stop();
});

type Agent = { key: AgentKey; token: Delegated };

/** A person starts an agent. */
async function start(name: string, access: Access, personToken = mayaToken): Promise<Agent> {
  const k = await newAgentKey();
  return { key: k, token: await exchange(`${gw}/token`, { personToken, actor: k, name, access }) };
}

/** An agent starts another agent: it signs an assertion for the new agent's key, and the new agent redeems it. */
async function spawn(parent: Agent, name: string, access: Access): Promise<Agent> {
  const k = await newAgentKey();
  const assertion = await delegationAssertion(parent.key, parent.token.access_token, { to: k.jkt, access, tokenEndpoint: `${gw}/token` });
  return { key: k, token: await exchange(`${gw}/token`, { assertion, actor: k, name }) };
}

/** An ordinary MCP client; the only change is the `fetch` it is given. */
async function connect(agent: Agent): Promise<Client> {
  const client = new Client({ name: "delegation-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gw}/mcp`), { fetch: dpopFetch(agent.key, agent.token.access_token) }));
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
  if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { code: (r.structuredContent as { error?: { code?: string } })?.error?.code });
  return r.structuredContent as T;
}

/** One raw MCP request through the gateway, with whatever credentials the caller chooses. */
function raw(headers: Record<string, string>, target = `${gw}/mcp`): Promise<Response> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return fetch(target, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
}

async function refusedExchange(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => e instanceof ExchangeError && e.code === code, `expected ${code}`);
}

async function revoke(authorization: string, form: Record<string, string>, proof?: string): Promise<number> {
  const res = await fetch(`${gw}/revoke`, { method: "POST", headers: { authorization, ...(proof ? { dpop: proof } : {}) }, body: new URLSearchParams(form) });
  return res.status;
}

test("a person starts an agent: the token names the person, the agent, the key and the limits, and posts trace to the person", async () => {
  const fx = await start("fx", { actions: ALL, boards: [boardId] });
  assert.equal(fx.token.token_type, "DPoP");
  const claims = decodeJwt(fx.token.access_token) as { sub: string; act: { sub: string; act?: unknown }; cnf: { jkt: string }; authorization_details: { type: string; actions: string[]; boards: string[] }[]; exp: number; iat: number };
  assert.equal(claims.sub, mayaId, "sub is the person");
  assert.equal(claims.cnf.jkt, fx.key.jkt, "bound to the agent's key");
  assert.equal(claims.act.act, undefined, "a person's own agent has no prior actor");
  assert.deepEqual(claims.authorization_details[0]!.boards, [boardId]);
  assert.equal(claims.authorization_details[0]!.type, DETAIL_TYPE);
  assert.ok(claims.exp - claims.iat <= 3600, "at most an hour unless the person says otherwise");

  const client = await connect(fx);
  const me = await call<{ principal: { id: string; kind: string; display_name: string; owner: { id: string }; scope: { boards: string[]; can: string[] } } }>(client, "whoami");
  assert.equal(me.principal.kind, "agent");
  assert.equal(me.principal.display_name, "fx");
  assert.equal(me.principal.owner.id, mayaId);
  assert.equal(me.principal.id, claims.act.sub, "act.sub is the agent's principal on the board");
  assert.deepEqual(me.principal.scope.boards, [boardId]);

  const started = await call<{ message: { author: { display_name: string; via: { id: string } } } }>(client, "start_thread", { board_id: boardId, title: "From fx", body: "hello", idempotency_key: key() });
  assert.equal(started.message.author.display_name, "fx");
  assert.equal(started.message.author.via.id, mayaId, "the post traces to the person (P3)");
  await client.close();
});

test("attack 1: a stolen token without the key is useless", async () => {
  const fx = await start("fx", { actions: ALL });
  const token = fx.token.access_token;
  // As a bearer token (RFC 9449 §7.2).
  const bearer = await raw({ authorization: `Bearer ${token}` });
  assert.equal(bearer.status, 401);
  assert.match(bearer.headers.get("www-authenticate") ?? "", /^DPoP .*error="invalid_token"/);
  // With no proof, and with a proof from the thief's own key.
  assert.equal((await raw({ authorization: `DPoP ${token}` })).status, 401);
  const thief = await newAgentKey();
  const forged = await raw({ authorization: `DPoP ${token}`, dpop: await dpopProof(thief, { method: "POST", url: `${gw}/mcp`, accessToken: token }) });
  assert.equal(forged.status, 401);
  // The board server itself never accepts it: the token means something only at the gateway.
  assert.equal((await raw({ authorization: `Bearer ${token}` }, `${board.url}/mcp`)).status, 401);
  // The holder of the key is served.
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: await dpopProof(fx.key, { method: "POST", url: `${gw}/mcp`, accessToken: token }) })).status, 200);
});

test("attack 2: a captured proof can't be replayed or moved to another request or token", async () => {
  const fx = await start("fx", { actions: ALL });
  const other = await start("fy", { actions: ALL });
  const token = fx.token.access_token;
  const proof = await dpopProof(fx.key, { method: "POST", url: `${gw}/mcp`, accessToken: token });
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: proof })).status, 200);
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: proof })).status, 401, "same proof twice");
  const wrongMethod = await dpopProof(fx.key, { method: "GET", url: `${gw}/mcp`, accessToken: token });
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: wrongMethod })).status, 401);
  const wrongUrl = await dpopProof(fx.key, { method: "POST", url: `${gw}/token`, accessToken: token });
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: wrongUrl })).status, 401);
  const wrongToken = await dpopProof(fx.key, { method: "POST", url: `${gw}/mcp`, accessToken: other.token.access_token });
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: wrongToken })).status, 401);
  // A proof made three minutes ago, otherwise correct.
  const stale = await new SignJWT({ htm: "POST", htu: `${gw}/mcp`, jti: "stale-1", ath: decodeJwt(wrongMethod).ath })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: fx.key.publicJwk })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 180)
    .sign(fx.key.privateKey);
  assert.equal((await raw({ authorization: `DPoP ${token}`, dpop: stale })).status, 401);
});

test("a person gives an agent less than they have: read only, one board, a short time", async () => {
  const reader = await start("reader", { actions: ["read"], boards: [boardId], access_ends_at: new Date(Date.now() + 120_000).toISOString() });
  assert.ok(reader.token.expires_in <= 120);
  const client = await connect(reader);
  await call(client, "list_threads", { board_id: boardId });
  await assert.rejects(call(client, "start_thread", { board_id: boardId, title: "x", body: "y", idempotency_key: key() }), { code: "forbidden" });
  // Managing is never delegated, whatever the person can do themselves.
  await assert.rejects(call(client, "create_scoped_token", {}), { code: "forbidden" });
  await assert.rejects(call(client, "create_invite", { board_id: boardId, audience: "link", role: "reader" }), { code: "forbidden" });
  // A board outside the limits looks like it does not exist, though the person can reach it.
  const own = ensureOwnBoard(board.ctx, actorFromPrincipal(ensureHuman(board.ctx, { email: "maya@example.test" }), "test_token"), { create: true })!.id;
  await assert.rejects(call(client, "list_threads", { board_id: own }), { code: "not_found" });
  await client.close();
  // A board the person can't reach can't be delegated.
  await refusedExchange(() => start("reader", { actions: ["read"], boards: ["b_does_not_exist"] }), "invalid_authorization_details");
});

test("an agent starts an agent: the chain is recorded and still traces to the person", async () => {
  const fx = await start("fx", { actions: ALL, boards: [boardId], sub_agents: 1 });
  const scout = await spawn(fx, "scout", { actions: ["read"] });
  const claims = decodeJwt(scout.token.access_token) as { sub: string; act: { sub: string; act: { sub: string } }; cnf: { jkt: string }; authorization_details: { actions: string[]; boards: string[] }[]; exp: number };
  const parent = decodeJwt(fx.token.access_token) as { act: { sub: string }; exp: number };
  assert.equal(claims.sub, mayaId, "sub is still the person");
  assert.equal(claims.act.act.sub, parent.act.sub, "the prior actor is the agent that started it (RFC 8693 §4.1)");
  assert.notEqual(claims.act.sub, parent.act.sub);
  assert.equal(claims.cnf.jkt, scout.key.jkt);
  assert.deepEqual(claims.authorization_details[0]!.actions, ["read"]);
  assert.deepEqual(claims.authorization_details[0]!.boards, [boardId], "limits it didn't narrow are inherited, not widened");
  assert.ok(claims.exp <= parent.exp, "it can't outlive the agent that started it");

  const client = await connect(scout);
  const me = await call<{ principal: { display_name: string; owner: { id: string } } }>(client, "whoami");
  assert.equal(me.principal.display_name, "scout");
  assert.equal(me.principal.owner.id, mayaId);
  await assert.rejects(call(client, "start_thread", { board_id: boardId, title: "x", body: "y", idempotency_key: key() }), { code: "forbidden" });
  await client.close();
});

test("attack 3: an agent can't give more than it has", async () => {
  const reader = await start("reader", { actions: ["read"], boards: [boardId], access_ends_at: new Date(Date.now() + 600_000).toISOString(), sub_agents: 1 });
  await refusedExchange(() => spawn(reader, "more", { actions: ALL }), "invalid_authorization_details");
  await refusedExchange(() => spawn(reader, "wider", { actions: ["read"], boards: [boardId, "b_other"] }), "invalid_authorization_details");
  await refusedExchange(() => spawn(reader, "longer", { actions: ["read"], access_ends_at: new Date(Date.now() + 3_000_000).toISOString() }), "invalid_authorization_details");
  await refusedExchange(() => spawn(reader, "deeper", { actions: ["read"], sub_agents: 1 }), "invalid_authorization_details");
  // The new agent can't widen what the assertion gives by asking for more in the request.
  const k = await newAgentKey();
  const assertion = await delegationAssertion(reader.key, reader.token.access_token, { to: k.jkt, access: { actions: ["read"] }, tokenEndpoint: `${gw}/token` });
  const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: assertion, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", authorization_details: JSON.stringify([{ type: DETAIL_TYPE, actions: ALL }]) });
  const res = await fetch(`${gw}/token`, { method: "POST", headers: { dpop: await dpopProof(k, { method: "POST", url: `${gw}/token` }) }, body: form });
  assert.equal(res.status, 400);
});

test("attack 4: a stolen token can't start an agent, and nothing but a person starts a chain", async () => {
  const fx = await start("fx", { actions: ALL, sub_agents: 1 });
  const thief = await newAgentKey();
  const endpoint = `${gw}/token`;
  // The thief has fx's token but not fx's key. As a subject token it is not a person's token.
  await refusedExchange(() => exchange(endpoint, { personToken: fx.token.access_token, actor: thief, name: "thief", access: { actions: ["read"] } }), "invalid_grant");
  // An assertion the thief signs for fx's token comes from the wrong key.
  const forged = await delegationAssertion(thief, fx.token.access_token, { to: thief.jkt, access: { actions: ["read"] }, tokenEndpoint: endpoint });
  await refusedExchange(() => exchange(endpoint, { assertion: forged, actor: thief, name: "thief" }), "invalid_grant");
  // A real assertion, intercepted: it was made for another key, and it works once.
  const scoutKey = await newAgentKey();
  const real = await delegationAssertion(fx.key, fx.token.access_token, { to: scoutKey.jkt, access: { actions: ["read"] }, tokenEndpoint: endpoint });
  await refusedExchange(() => exchange(endpoint, { assertion: real, actor: thief, name: "thief" }), "invalid_grant");
  await exchange(endpoint, { assertion: real, actor: scoutKey, name: "scout" });
  await refusedExchange(() => exchange(endpoint, { assertion: real, actor: scoutKey, name: "scout" }), "invalid_grant");
  // A narrowed token of the person is not the person, and neither is a string.
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${board.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mayaToken}` } } }));
  const scoped = await call<{ token: string }>(client, "create_scoped_token", {});
  await client.close();
  await refusedExchange(() => exchange(endpoint, { personToken: scoped.token, actor: thief, name: "thief", access: { actions: ["read"] } }), "invalid_grant");
  await refusedExchange(() => exchange(endpoint, { personToken: "omb_tt_not_a_token", actor: thief, name: "thief", access: { actions: ["read"] } }), "invalid_grant");
  // Nor is an agent the person created, with its own agent token.
  const maya = actorFromPrincipal(ensureHuman(board.ctx, { email: "maya@example.test" }), "test_token");
  const agentToken = mintToken(board.ctx, createAgent(board.ctx, maya, "release-agent").id, "agent").token;
  await refusedExchange(() => exchange(endpoint, { personToken: agentToken, actor: thief, name: "thief", access: { actions: ["read"] } }), "invalid_grant");
  // The token is bound to the key that signed the request: an actor token from another key is refused.
  const other = await newAgentKey();
  const mixed = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: mayaToken, subject_token_type: "urn:ietf:params:oauth:token-type:access_token", actor_token_type: "urn:ietf:params:oauth:token-type:jwt", authorization_details: JSON.stringify([{ type: DETAIL_TYPE, actions: ["read"] }]) });
  mixed.set("actor_token", await actorToken(other, "mixed", endpoint));
  const res = await fetch(endpoint, { method: "POST", headers: { dpop: await dpopProof(thief, { method: "POST", url: endpoint }) }, body: mixed });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  // And without a proof there is no key to bind to (RFC 9449 §5).
  const bare = await fetch(endpoint, { method: "POST", body: mixed });
  assert.equal(((await bare.json()) as { error: string }).error, "invalid_dpop_proof");
});

test("attack 5: an agent starts agents only if its person said so, and only so deep", async () => {
  // By default an agent starts none.
  const plain = await start("plain", { actions: ALL });
  await refusedExchange(() => spawn(plain, "child", { actions: ["read"] }), "invalid_grant");
  // A person can allow at most MAX_SUB_AGENTS levels; each level has one fewer to give.
  await refusedExchange(() => start("greedy", { actions: ALL, sub_agents: MAX_SUB_AGENTS + 1 }), "invalid_authorization_details");
  let cur = await start("d0", { actions: ALL, sub_agents: MAX_SUB_AGENTS });
  for (let left = MAX_SUB_AGENTS - 1; left >= 0; left--) cur = await spawn(cur, `d${MAX_SUB_AGENTS - left}`, { actions: ALL, sub_agents: left });
  const last = cur;
  await refusedExchange(() => spawn(last, "too-deep", { actions: ["read"] }), "invalid_grant");
});

test("revoking one agent stops it and everything it started, and nothing else", async () => {
  const fx = await start("fx", { actions: ALL, sub_agents: 1 });
  const scout = await spawn(fx, "scout", { actions: ["read"] });
  const other = await start("other", { actions: ALL });
  const proofFor = (a: Agent) => dpopProof(a.key, { method: "POST", url: `${gw}/mcp`, accessToken: a.token.access_token });
  const status = async (a: Agent) => (await raw({ authorization: `DPoP ${a.token.access_token}`, dpop: await proofFor(a) })).status;
  assert.deepEqual([await status(fx), await status(scout), await status(other)], [200, 200, 200]);

  // Someone else can't revoke Maya's agent, and learns nothing by trying (RFC 7009 §2.2).
  assert.equal(await revoke(`Bearer ${ownerToken}`, { token: fx.token.access_token }), 200);
  assert.equal(await status(fx), 200);
  // An agent can't revoke the agent that started it.
  const upward = await dpopProof(scout.key, { method: "POST", url: `${gw}/revoke`, accessToken: scout.token.access_token });
  assert.equal(await revoke(`DPoP ${scout.token.access_token}`, { token: fx.token.access_token }, upward), 200);
  assert.equal(await status(fx), 200);

  // A request in flight is cut when the delegation is revoked.
  const scoutClient = await connect(scout);
  const waiting = call(scoutClient, "wait_for_activity", { board_id: boardId, timeout_seconds: 25 }).then(
    () => "returned",
    () => "cut",
  );
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  assert.equal(await revoke(`Bearer ${mayaToken}`, { token: fx.token.access_token }), 200);
  assert.deepEqual([await status(fx), await status(scout), await status(other)], [401, 401, 200]);
  assert.equal(await Promise.race([waiting, new Promise((r) => setTimeout(() => r("still open"), 5000))]), "cut");
  assert.ok(Date.now() - t0 < 5000, "within the spec's 5 second window for removal");
  await scoutClient.close().catch(() => undefined);

  // The person is untouched, and a revoked agent can't start anything.
  assert.equal((await raw({ authorization: `Bearer ${mayaToken}` }, `${board.url}/mcp`)).status, 200);
  await refusedExchange(() => spawn(fx, "after", { actions: ["read"] }), "invalid_grant");
  assert.equal(gateway.list().find((d) => d.jkt === scout.key.jkt)!.revoked, true);
});

test("an agent can revoke what it started", async () => {
  const fx = await start("fx", { actions: ALL, sub_agents: 1 });
  const scout = await spawn(fx, "scout", { actions: ["read"] });
  const proof = await dpopProof(fx.key, { method: "POST", url: `${gw}/revoke`, accessToken: fx.token.access_token });
  assert.equal(await revoke(`DPoP ${fx.token.access_token}`, { token: scout.token.access_token }, proof), 200);
  const dead = await raw({ authorization: `DPoP ${scout.token.access_token}`, dpop: await dpopProof(scout.key, { method: "POST", url: `${gw}/mcp`, accessToken: scout.token.access_token }) });
  assert.equal(dead.status, 401);
  const alive = await raw({ authorization: `DPoP ${fx.token.access_token}`, dpop: await dpopProof(fx.key, { method: "POST", url: `${gw}/mcp`, accessToken: fx.token.access_token }) });
  assert.equal(alive.status, 200);
});

test("when the person leaves the board, so does every agent in the chain (P3, P9)", async () => {
  const ctx = board.ctx;
  const guest = ensureHuman(ctx, { email: "guest@example.test", displayName: "Guest" });
  const owner = actorFromPrincipal(ensureHuman(ctx, { email: "owner@example.test" }), "test_token");
  redeemInvite(ctx, actorFromPrincipal(guest, "test_token"), createInvite(ctx, owner, boardId, { audience: "email", value: "guest@example.test", role: "contributor" }).url!);
  const guestToken = mintToken(ctx, guest.id, "test").token;
  const fx = await start("fx", { actions: ALL, boards: [boardId], sub_agents: 1 }, guestToken);
  const scout = await spawn(fx, "scout", { actions: ["read"] });
  const client = await connect(scout);
  await call(client, "list_threads", { board_id: boardId });
  removeMember(ctx, owner, boardId, guest.id);
  await assert.rejects(call(client, "list_threads", { board_id: boardId }), (e: { code?: string }) => e.code === "access_ended" || e.code === "not_found");
  await client.close();
});

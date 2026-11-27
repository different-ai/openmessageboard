import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { freePort } from "./helpers.ts";

let running: Running;
let base: string;
const tokens: Record<string, string> = {};
const clients: Client[] = [];

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-auto-e2e-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
  for (const [name, email] of [["owner", "owner@example.test"], ["maya", "maya@example.test"]] as const) {
    tokens[name] = mintToken(running.ctx, ensureHuman(running.ctx, { email, displayName: name }).id, "test").token;
  }
});

after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await running.stop();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
  if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { body: r.structuredContent });
  return r.structuredContent as T;
}

async function api<T = Record<string, unknown>>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw Object.assign(new Error(JSON.stringify(json)), { status: res.status });
  return json;
}

test("filtered reads, waits, schedules and watchers over MCP and the web API", async (t) => {
  const owner = await connect(tokens.owner!);
  const maya = await connect(tokens.maya!);
  const me = await call<{ owned_board: { id: string }; principal: { id: string } }>(owner, "whoami");
  const boardId = me.owned_board.id;
  const { invite } = await call<{ invite: { url: string } }>(owner, "create_invite", { board_id: boardId, audience: "link", role: "contributor" });
  await call(maya, "redeem_invite", { invite: invite.url });

  // post, the answer lands, then wait after the post: it returns at once
  const t1 = await call<{ thread: { id: string }; message: { id: string } }>(owner, "start_thread", { board_id: boardId, title: "Cache?", body: "Is it safe to cache?", idempotency_key: "e2e-1" });
  const answer = await call<{ message: { id: string } }>(maya, "reply", { thread_id: t1.thread.id, body: "Yes, for 60 s", idempotency_key: "e2e-2" });
  const waited = await call<{ changes: { message_id: string }[] }>(owner, "wait_for_activity", { thread_id: t1.thread.id, after: t1.message.id, timeout_seconds: 5 });
  assert.deepEqual(waited.changes.map((c) => c.message_id), [answer.message.id]);

  const read = await call<{ messages: { id: string }[]; cursor: string; has_more: boolean }>(owner, "read_messages", { board_id: boardId, by: "maya" });
  assert.deepEqual(read.messages.map((m) => m.id), [answer.message.id]);
  const viaWeb = await api<{ messages: { id: string }[] }>(tokens.owner!, "GET", `/api/boards/${boardId}/messages?text=CACHE&re=${t1.thread.id}`);
  assert.equal(viaWeb.messages.length, 1);
  const changes = await api<{ changes: { message_id: string }[] }>(tokens.owner!, "GET", `/api/boards/${boardId}/changes?after=${t1.message.id}&by=maya`);
  assert.deepEqual(changes.changes.map((c) => c.message_id), [answer.message.id]);

  // the browser stream sends only matching changes
  const ac = new AbortController();
  const res = await fetch(`${base}/api/boards/${boardId}/stream?by=maya&after=${t1.message.id}`, { headers: { authorization: `Bearer ${tokens.owner}` }, signal: ac.signal });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes(answer.message.id)) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  assert.ok(!text.includes(`"message_id":"${t1.message.id}"`), "changes that do not match are not sent");

  // a schedule fires through the runner, as its creator
  const sched = await call<{ schedule: { id: string } }>(maya, "schedule_post", { thread_id: t1.thread.id, body: "Scheduled ping", in_seconds: 1 });
  let posted = false;
  for (let i = 0; i < 40 && !posted; i++) {
    await new Promise((r) => setTimeout(r, 100));
    posted = (await call<{ messages: unknown[] }>(owner, "read_messages", { board_id: boardId, text: "Scheduled ping" })).messages.length === 1;
  }
  assert.ok(posted, "the scheduled post appeared");
  const list = await call<{ schedules: { id: string; state: string }[] }>(maya, "list_schedules", { thread_id: t1.thread.id, all: true });
  assert.equal(list.schedules.find((s) => s.id === sched.schedule.id)?.state, "done");
  const viaApi = await api<{ schedule: { id: string } }>(tokens.maya!, "POST", `/api/threads/${t1.thread.id}/schedules`, { body: "later", in_seconds: 3600 });
  const cancelled = await api<{ cancelled: boolean }>(tokens.owner!, "DELETE", `/api/schedules/${viaApi.schedule.id}`);
  assert.equal(cancelled.cancelled, true);

  // a watcher over MCP receives a signed delivery for a matching change only
  const got: Record<string, unknown>[] = [];
  const hook: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      got.push(body);
      if (body.type === "verification") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: body.challenge }));
      else res.writeHead(204).end();
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => hook.listen(port, "127.0.0.1", () => r()));
  t.after(() => hook.close());
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const { watcher } = await call<{ watcher: { id: string } }>(owner, "create_watcher", { board_id: boardId, url: `http://127.0.0.1:${port}/hook`, secret, filter: { text: "deploy" } });
  await call(maya, "reply", { thread_id: t1.thread.id, body: "unrelated", idempotency_key: "e2e-3" });
  await call(maya, "reply", { thread_id: t1.thread.id, body: "deploy is green", idempotency_key: "e2e-4" });
  for (let i = 0; i < 50 && !got.some((g) => g.type === "change"); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const deliveries = got.filter((g) => g.type === "change");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.watcher_id, watcher.id);
  const watchers = await api<{ watchers: { id: string }[] }>(tokens.owner!, "GET", `/api/boards/${boardId}/watchers`);
  assert.equal(watchers.watchers.length, 1);
  await assert.rejects(api(tokens.maya!, "GET", `/api/boards/${boardId}/watchers`), /forbidden/);
  await call(owner, "delete_watcher", { watcher_id: watcher.id });
});

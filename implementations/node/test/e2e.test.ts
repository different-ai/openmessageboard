import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
const anyResult = z.object({}).passthrough();
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { freePort } from "./helpers.ts";

let running: Running;
let base: string;
const tokens: Record<string, string> = {};

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-e2e-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
  for (const [name, email] of [["owner", "owner@example.test"], ["maya", "maya@example.test"], ["outsider", "out@elsewhere.test"]] as const) {
    tokens[name] = mintToken(running.ctx, ensureHuman(running.ctx, { email, displayName: name }).id, "test").token;
  }
});

after(async () => {
  await running.stop();
});

async function connect(token: string, mode: "auto" | "legacy" = "auto"): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
  if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { body: r.structuredContent });
  return (r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}")) as T;
}

test("unauthenticated MCP requests get a 401 with resource metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=".*oauth-protected-resource\/mcp"/);
  const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { authorization_servers: string[] };
  assert.equal(meta.authorization_servers[0], `${base}/api/auth`);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)).json()) as Record<string, unknown>;
  assert.equal(as.issuer, `${base}/api/auth`);
  assert.equal(as.client_id_metadata_document_supported, true);
  const info = (await (await fetch(`${base}/.well-known/openmessageboard`)).json()) as { profiles: string[] };
  assert.ok(info.profiles.includes("events"));
});

test("release-thread journey over MCP: board, invite, live reply, catch-up", async () => {
  const owner = await connect(tokens.owner!);
  const maya = await connect(tokens.maya!);
  const tools = await owner.listTools();
  assert.equal(tools.tools[0]?.name, "whoami");
  const me = await call<{ owned_board: { id: string; url: string } }>(owner, "whoami");
  const boardId = me.owned_board.id;
  const again = await call<{ owned_board: { id: string } }>(owner, "whoami");
  assert.equal(again.owned_board.id, boardId);

  const inv = await call<{ invite: { url: string } }>(owner, "create_invite", { board_id: boardId, audience: "email", value: "maya@example.test", role: "contributor" });
  await call(maya, "redeem_invite", { invite: inv.invite.url });
  const started = await call<{ thread: { id: string; url: string }; as_of?: string }>(owner, "start_thread", {
    board_id: boardId,
    title: "What's left before Friday's release?",
    body: "Post what you're checking.",
    idempotency_key: "e2e-start-1",
  });
  const threadId = started.thread.id;
  const { as_of } = await call<{ as_of: string }>(owner, "get_thread", { thread_id: threadId });

  // Owner listens on the thread; Maya replies; the owner gets a resource update and reads it by cursor.
  const updated: string[] = [];
  owner.setNotificationHandler("notifications/resources/updated", (n) => {
    updated.push(n.params.uri);
  });
  const sub = await owner.listen({ resourceSubscriptions: [started.thread.url, `${base}/b/b_NOT_MINE`] });
  assert.deepEqual(sub.honoredFilter.resourceSubscriptions, [started.thread.url]);
  await call(maya, "reply", { thread_id: threadId, body: "Android is ready. I'm checking iOS now.", idempotency_key: "e2e-reply-1" });
  for (let i = 0; i < 40 && updated.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(updated, [started.thread.url]);
  const changes = await call<{ changes: { type: string; message: { body: string; author: { display_name: string } } | null }[]; cursor: string }>(owner, "get_changes", {
    board_id: boardId,
    cursor: as_of,
  });
  assert.equal(changes.changes.at(-1)?.message?.body, "Android is ready. I'm checking iOS now.");
  await sub.close();

  // Owner is away; Maya posts twice; owner catches up in order and sees the mention in the inbox.
  const ownerId = (await call<{ principal: { id: string } }>(owner, "whoami")).principal.id;
  await call(maya, "reply", { thread_id: threadId, body: "iOS is ready too.", idempotency_key: "e2e-reply-2" });
  await call(maya, "reply", { thread_id: threadId, body: "Release notes are drafted.", mentions: [ownerId], idempotency_key: "e2e-reply-3" });
  const caught = await call<{ changes: { message: { body: string } | null }[] }>(owner, "get_changes", { board_id: boardId, cursor: changes.cursor });
  assert.deepEqual(caught.changes.map((c) => c.message?.body), ["iOS is ready too.", "Release notes are drafted."]);
  const inbox = await call<{ items: { kind: string }[] }>(owner, "get_inbox", { unread_only: true });
  assert.equal(inbox.items[0]?.kind, "mention");

  // Retrying with the same key does not post twice.
  await call(maya, "reply", { thread_id: threadId, body: "Release notes are drafted.", mentions: [ownerId], idempotency_key: "e2e-reply-3" });
  const t = await call<{ messages: unknown[] }>(owner, "get_thread", { thread_id: threadId });
  assert.equal(t.messages.length, 4);

  // Outsiders can't see the board; errors are structured.
  const outsider = await connect(tokens.outsider!);
  await assert.rejects(call(outsider, "get_thread", { thread_id: threadId }), (e: Error & { body?: { error: { code: string } } }) => e.body?.error.code === "not_found");

  // Resources
  const res = await owner.readResource({ uri: started.thread.url });
  assert.match((res.contents[0] as { text: string }).text, /Android is ready/);
  await Promise.all([owner.close(), maya.close(), outsider.close()]);
});

test("wait_for_activity returns when another member posts", async () => {
  const owner = await connect(tokens.owner!);
  const maya = await connect(tokens.maya!);
  const me = await call<{ owned_board: { id: string } }>(owner, "whoami");
  const pos = await call<{ cursor: string }>(maya, "get_changes", { board_id: me.owned_board.id });
  const waiting = call<{ changes: unknown[] }>(maya, "wait_for_activity", { board_id: me.owned_board.id, cursor: pos.cursor, timeout_seconds: 10 });
  const poster = new Promise((r) => setTimeout(r, 200)).then(() => call(owner, "start_thread", { board_id: me.owned_board.id, title: "Ping", body: "Anyone there?", idempotency_key: "e2e-wait" }));
  const [got] = await Promise.all([waiting, poster]);
  assert.ok(got.changes.length >= 1);
  await Promise.all([owner.close(), maya.close()]);
});

test("legacy (2025) clients can list and call tools", async () => {
  const legacy = await connect(tokens.owner!, "legacy");
  const tools = await legacy.listTools();
  assert.ok(tools.tools.some((t) => t.name === "claim_task"));
  const me = await call<{ owned_board: { id: string } }>(legacy, "whoami");
  assert.ok(me.owned_board.id.startsWith("b_"));
  await legacy.close();
});

test("events: list, poll and signed webhook delivery with verification", async (t) => {
  const owner = await connect(tokens.owner!);
  const maya = await connect(tokens.maya!);
  const me = await call<{ owned_board: { id: string } }>(owner, "whoami");
  const list = (await owner.request({ method: "events/list", params: {} } as never, anyResult)) as unknown as { events: { name: string }[] };
  assert.deepEqual(list.events.map((e) => e.name).sort(), ["board.message_created", "board.task_updated", "inbox.item_created"]);

  const secret = "whsec_" + randomBytes(32).toString("base64");
  const received: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
  const receiver: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const id = String(req.headers["webhook-id"]);
      const ts = String(req.headers["webhook-timestamp"]);
      const expected = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
      if (req.headers["webhook-signature"] !== expected) {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ body, headers: req.headers });
      if (body.type === "verification") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: body.challenge }));
      else res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  t.after(() => receiver.close());
  const port = (receiver.address() as { port: number }).port;
  const sub = (await owner.request(
    { method: "events/subscribe", params: { name: "board.message_created", arguments: { board_id: me.owned_board.id }, delivery: { mode: "webhook", url: `http://127.0.0.1:${port}/hook`, secret } } } as never,
    anyResult,
  )) as unknown as { id: string; refreshBefore: string };
  assert.ok(sub.id.startsWith("sub_"));
  assert.equal(received[0]?.body.type, "verification");
  const posted = await call<{ thread: { id: string } }>(maya, "start_thread", { board_id: me.owned_board.id, title: "Webhook", body: "Hello hook", idempotency_key: "e2e-hook" });
  for (let i = 0; i < 60 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const ev = received[1]?.body as { name: string; data: { thread: { id: string }; message: { body: string } } } | undefined;
  assert.equal(ev?.name, "board.message_created");
  assert.equal(ev?.data.thread.id, posted.thread.id);
  assert.equal(received[1]?.headers["x-mcp-subscription-id"], sub.id);

  // A private, non-loopback callback is refused.
  await assert.rejects(
    owner.request({ method: "events/subscribe", params: { name: "inbox.item_created", arguments: {}, delivery: { mode: "webhook", url: "https://10.0.0.5/hook", secret } } } as never, anyResult),
  );
  const polled = (await owner.request({ method: "events/poll", params: { name: "board.message_created", arguments: { board_id: me.owned_board.id }, cursor: null } } as never, anyResult)) as unknown as {
    cursor: string;
  };
  assert.ok(polled.cursor);
  receiver.close();
  await Promise.all([owner.close(), maya.close()]);
});

test("browser SSE stream replays and streams changes", async () => {
  const owner = await connect(tokens.owner!);
  const me = await call<{ owned_board: { id: string } }>(owner, "whoami");
  const ac = new AbortController();
  const res = await fetch(`${base}/api/boards/${me.owned_board.id}/stream`, { headers: { authorization: `Bearer ${tokens.owner}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let text = "";
  const readUntil = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(text); i++) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 100))]);
      if (value) text += new TextDecoder().decode(value);
      if (done && !value) continue;
    }
  };
  await readUntil(/event: ready/);
  await call(owner, "start_thread", { board_id: me.owned_board.id, title: "Live in browser", body: "SSE works", idempotency_key: "e2e-sse" });
  await readUntil(/SSE works/);
  assert.match(text, /event: change/);
  ac.abort();
  await owner.close();
});

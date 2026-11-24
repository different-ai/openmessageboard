import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { actorFromPrincipal } from "@openmessageboard/core/domain/access";
import { addAgentToBoard, createAgent, createAgentToken, ensureHuman, mintToken, removeMember } from "@openmessageboard/core/domain/boards";
import { eventsDialect } from "@openmessageboard/core/mcp/events";
import type { Actor } from "@openmessageboard/core/domain/model";
import { freePort } from "./helpers.ts";

const anyResult = z.object({}).passthrough();
const EXT = "io.modelcontextprotocol/events";
const here = dirname(fileURLToPath(import.meta.url));

let running: Running;
let base: string;
let owner: Actor;
let ownerToken: string;
let boardId: string;
const agents: Record<"claude" | "chatgpt" | "robot", { id: string; token: string }> = {} as never;

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-events-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
  const row = ensureHuman(running.ctx, { email: "owner@example.test", displayName: "Owner" });
  owner = actorFromPrincipal(row, "test");
  ownerToken = mintToken(running.ctx, row.id, "test").token;
  const me = await rpc<{ structuredContent: { owned_board: { id: string } } }>(ownerToken, "tools/call", { name: "whoami", arguments: {} });
  boardId = me.structuredContent.owned_board.id;
  for (const [key, name] of [["claude", "Claude"], ["chatgpt", "ChatGPT"], ["robot", "Robot"]] as const) {
    const a = createAgent(running.ctx, owner, name);
    addAgentToBoard(running.ctx, owner, boardId, a.id, "contributor");
    agents[key] = { id: a.id, token: createAgentToken(running.ctx, owner, a.id).token };
  }
});

after(async () => {
  await running.stop();
});

/** One 2025-era JSON-RPC call through the SDK client (what a ChatGPT-style client sends). */
async function rpc<T = Record<string, unknown>>(token: string, method: string, params: Record<string, unknown>): Promise<T> {
  const client = new Client({ name: "events-test", version: "1.0.0" }, { versionNegotiation: { mode: "legacy" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    if (method === "tools/call") {
      const r = (await client.callTool(params as { name: string; arguments: Record<string, unknown> })) as { isError?: boolean; structuredContent?: unknown };
      if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { body: r.structuredContent });
      return r as T;
    }
    return (await client.request({ method, params } as never, anyResult)) as T;
  } finally {
    await client.close();
  }
}

async function tool<T = Record<string, unknown>>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  return (await rpc<{ structuredContent: T }>(token, "tools/call", { name, arguments: args })).structuredContent;
}

type Frame = { jsonrpc: "2.0"; method?: string; id?: number; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; data?: Record<string, unknown> } };

/** Opens `events/stream` with raw HTTP and yields each SSE `data:` frame. */
async function openStream(token: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-name": String(params.name), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "events/stream", params }),
  });
  const frames: Frame[] = [];
  let waiters: (() => void)[] = [];
  let ended = false;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const data = buf
              .slice(0, i)
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("");
            buf = buf.slice(i + 2);
            if (data) frames.push(JSON.parse(data) as Frame);
            for (const w of waiters) w();
            waiters = [];
          }
        }
      } catch {
        /* aborted */
      }
      ended = true;
      for (const w of waiters) w();
    })();
  }
  const next = async (pred: (f: Frame) => boolean, ms = 5000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i !== -1) return frames.splice(i, 1)[0]!;
      if (ended || Date.now() > deadline) throw new Error(`no matching frame within ${ms} ms; have ${JSON.stringify(frames.map((f) => f.method ?? f.result))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { res, next, close: () => ac.abort(), get ended() { return ended; } };
}

const method = (m: string) => (f: Frame) => f.method === m;

test("dialect: a client that declares the Events extension is standard; others get ChatGPT's profile", () => {
  assert.equal(eventsDialect({ _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [EXT]: {} } } } }), "standard");
  assert.equal(eventsDialect({ _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: {} } } }), "compat");
  assert.equal(eventsDialect({ name: "inbox.item_created" }), "compat");
});

test("events/list offers poll, push and webhook for every event", async () => {
  const r = await rpc<{ events: { name: string; delivery: string[] }[] }>(agents.chatgpt.token, "events/list", {});
  assert.equal(r.events.length, 3);
  for (const e of r.events) assert.deepEqual(e.delivery, ["poll", "push", "webhook"]);
});

test("events/stream: header check, access errors, confirmation, events, heartbeats, resume and termination", async () => {
  // Mcp-Name must name the same event as the body.
  const bad = await openStream(agents.robot.token, { name: "board.message_created", arguments: { board_id: boardId } }, { "mcp-name": "inbox.item_created" });
  assert.equal(bad.res.status, 400);
  assert.equal(((await bad.res.json()) as Frame).error?.code, -32020);
  // A board the caller can't read is Forbidden/not_found, answered before any stream opens.
  const forbidden = await openStream(agents.robot.token, { name: "board.message_created", arguments: { board_id: "b_nope" } });
  const fb = (await forbidden.res.json()) as Frame;
  assert.equal(fb.error?.code, -32024);
  assert.equal(fb.error?.data?.code, "not_found");
  // Unknown event names are NotFound.
  const unknown = await openStream(agents.robot.token, { name: "board.nope", arguments: { board_id: boardId } });
  assert.equal(((await unknown.res.json()) as Frame).error?.code, -32023);

  const s = await openStream(agents.robot.token, { name: "board.message_created", arguments: { board_id: boardId }, cursor: null, heartbeatMs: 300 });
  assert.match(s.res.headers.get("content-type") ?? "", /text\/event-stream/);
  const active = await s.next(method("notifications/events/active"));
  assert.equal(active.params?.heartbeatMs, 300);
  assert.equal(active.params?.truncated, false);
  assert.deepEqual(active.params?._meta, { "io.modelcontextprotocol/subscriptionId": 7 });
  // The robot's own message is not delivered to it; the owner's is.
  await tool(agents.robot.token, "start_thread", { board_id: boardId, title: "Mine", body: "robot talking", idempotency_key: "push-own" });
  const posted = await tool<{ thread: { id: string }; message: { id: string } }>(ownerToken, "start_thread", { board_id: boardId, title: "Push", body: "hello push", idempotency_key: "push-1" });
  const ev = await s.next(method("notifications/events/event"));
  assert.equal(ev.params?.name, "board.message_created");
  assert.equal(ev.params?.eventId, posted.message.id);
  assert.equal((ev.params?.data as { message: { body: string } }).message.body, "hello push");
  assert.equal((ev.params?._meta as Record<string, unknown>)["io.modelcontextprotocol/subscriptionId"], 7);
  const cursor = String(ev.params?.cursor);
  const hb = await s.next(method("notifications/events/heartbeat"), 2000);
  assert.ok(typeof hb.params?.cursor === "string");
  s.close();

  // Resume: an occurrence that arrived while disconnected is replayed from the cursor.
  const missed = await tool<{ message: { id: string } }>(ownerToken, "reply", { thread_id: posted.thread.id, body: "while you were away", idempotency_key: "push-2" });
  const again = await openStream(agents.robot.token, { name: "board.message_created", arguments: { board_id: boardId }, cursor });
  await again.next(method("notifications/events/active"));
  const replayed = await again.next(method("notifications/events/event"));
  assert.equal(replayed.params?.eventId, missed.message.id);

  // Losing access ends the subscription with terminated, then the final result frame.
  removeMember(running.ctx, owner, boardId, agents.robot.id);
  const term = await again.next(method("notifications/events/terminated"));
  assert.equal((term.params?.error as { code: number }).code, -32024);
  assert.equal((term.params?.error as { data: { reason: string } }).data.reason, "access_ended");
  const done = await again.next((f) => f.result !== undefined);
  assert.equal(done.result?.resultType, "complete");
});

function receiver(secret: string, opts: { failChallenge?: boolean } = {}) {
  const received: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const id = String(req.headers["webhook-id"]);
      const ts = String(req.headers["webhook-timestamp"]);
      const expected = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
      if (req.headers["webhook-signature"] !== expected) return void res.writeHead(401).end();
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ body, headers: req.headers });
      if (body.type === "verification") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: opts.failChallenge ? "wrong" : body.challenge }));
      } else res.writeHead(204).end();
    });
  });
  const ready = new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}/hook`)));
  return { received, ready, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function waitFor<T>(fn: () => T | undefined, ms = 8000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("webhooks: ChatGPT-profile clients get -32015 on a failed challenge; declared Events clients get -32027", async (t) => {
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const r = receiver(secret, { failChallenge: true });
  t.after(() => r.close());
  const url = await r.ready;
  const params = { name: "inbox.item_created", arguments: {}, delivery: { mode: "webhook", url, secret } };
  await assert.rejects(rpc(agents.chatgpt.token, "events/subscribe", params), (e: { code?: number; data?: { reason?: string } }) => {
    assert.equal(e.code, -32015);
    assert.equal(e.data?.reason, "challenge_failed");
    return true;
  });
  await assert.rejects(
    rpc(agents.chatgpt.token, "events/subscribe", { ...params, _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [EXT]: {} } } } }),
    (e: { code?: number }) => {
      assert.equal(e.code, -32027);
      return true;
    },
  );
});

test("a Claude Code channel agent and a ChatGPT webhook agent trigger each other through the board", async (t) => {
  // ChatGPT: a webhook subscription to its inbox (2025-era client, no Events capability declared: ChatGPT's profile).
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const hook = receiver(secret);
  t.after(() => hook.close());
  const url = await hook.ready;
  const sub = await rpc<{ id: string }>(agents.chatgpt.token, "events/subscribe", { name: "inbox.item_created", arguments: {}, delivery: { mode: "webhook", url, secret }, cursor: null });
  assert.ok(sub.id);

  // Claude: `omb channel`, started the way Claude Code starts a channel (a stdio subprocess).
  const cliDir = join(here, "..", "..", "..", "packages", "cli");
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--conditions=source", "--import", "tsx", join(cliDir, "src", "index.ts"), "channel"], {
    cwd: cliDir,
    env: { ...process.env, OMB_SERVER: base, OMB_TOKEN: agents.claude.token, OMB_CHANNEL_HEARTBEAT_MS: "500", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-cli-")) },
  });
  t.after(() => child.kill());
  const out: Frame[] = [];
  const errLines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => out.push(JSON.parse(l) as Frame));
  createInterface({ input: child.stderr }).on("line", (l) => errLines.push(l));
  const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const take = (pred: (f: Frame) => boolean, what: string, ms = 10_000) =>
    waitFor(
      () => {
        const i = out.findIndex(pred);
        return i === -1 ? undefined : out.splice(i, 1)[0];
      },
      ms,
      `${what} (stderr: ${errLines.join(" | ")})`,
    );

  // A 2026-07-28 client probes server/discover first; the channel declines so the client uses initialize.
  send({ id: 1, method: "server/discover", params: {} });
  assert.equal((await take((f) => f.id === 1, "discover answer")).error?.code, -32601);
  send({ id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "test" } } });
  const init = await take((f) => f.id === 2, "initialize result");
  assert.deepEqual((init.result?.capabilities as { experimental: unknown }).experimental, { "claude/channel": {} });
  assert.equal(init.result?.protocolVersion, "2025-11-25");
  send({ method: "notifications/initialized" });
  send({ id: 3, method: "tools/list", params: {} });
  assert.deepEqual(((await take((f) => f.id === 3, "tools/list")).result?.tools as { name: string }[]).map((x) => x.name), ["reply"]);
  await waitFor(() => errLines.some((l) => l.includes("listening for inbox.item_created")), 10_000, "channel stream");

  // 1. ChatGPT mentions Claude → the channel pushes a notification into the Claude session.
  const ask = await tool<{ thread: { id: string }; message: { id: string } }>(agents.chatgpt.token, "start_thread", {
    board_id: boardId,
    title: "Review the parser",
    body: "Claude, can you review the parser change?",
    mentions: [agents.claude.id],
    idempotency_key: "x-1",
  });
  const n1 = await take(method("notifications/claude/channel"), "channel notification for the mention");
  const m1 = n1.params?.meta as Record<string, string>;
  assert.equal(m1.kind, "mention");
  assert.equal(m1.thread_id, ask.thread.id);
  assert.equal(m1.message_id, ask.message.id);
  assert.equal(m1.from_id, agents.chatgpt.id);
  for (const k of Object.keys(m1)) assert.match(k, /^[A-Za-z0-9_]+$/);
  assert.match(String(n1.params?.content), /^ChatGPT \(via Owner\) mentioned you in "Review the parser" on Owner's board:/);
  assert.match(String(n1.params?.content), /can you review the parser change\?/);

  // 2. Claude answers with the channel's reply tool, mentioning ChatGPT → ChatGPT's webhook fires.
  send({ id: 4, method: "tools/call", params: { name: "reply", arguments: { thread_id: m1.thread_id, body: "Reviewed: one bug on line 12. ChatGPT, can you fix it?", mentions: [m1.from_id], after: m1.message_id } } });
  const replied = await take((f) => f.id === 4, "reply tool result");
  assert.notEqual(replied.result?.isError, true, JSON.stringify(replied.result));
  const delivery = await waitFor(() => hook.received.find((d) => d.body.name === "inbox.item_created"), 10_000, "ChatGPT webhook delivery");
  const data = delivery.body.data as { kind: string; thread: { id: string }; message: { id: string; author: { id: string } } };
  assert.equal(data.kind, "mention");
  assert.equal(data.thread.id, ask.thread.id);
  assert.equal(data.message.author.id, agents.claude.id);
  assert.equal(delivery.headers["webhook-id"], String(delivery.body.eventId).replace(/[^A-Za-z0-9_-]/g, "_"));
  assert.equal(delivery.headers["x-mcp-subscription-id"], sub.id);

  // 3. ChatGPT replies in the thread → Claude follows it, so the channel fires again (the loop closes both ways).
  await tool(agents.chatgpt.token, "reply", { thread_id: ask.thread.id, body: "Fixed on line 12.", idempotency_key: "x-2" });
  const n2 = await take(method("notifications/claude/channel"), "channel notification for the follow-up");
  assert.equal((n2.params?.meta as Record<string, string>).kind, "reply");
  assert.match(String(n2.params?.content), /Fixed on line 12\./);

  // Removing ChatGPT from the board stops its subscription without a control envelope (ChatGPT's profile has none).
  const before = hook.received.length;
  removeMember(running.ctx, owner, boardId, agents.chatgpt.id);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(hook.received.slice(before).filter((d) => d.body.type === "terminated").length, 0);
  child.stdin.end();
});

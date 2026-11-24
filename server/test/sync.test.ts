import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ExternalLink, Integration, Message } from "@openmessageboard/protocol";
import { loadConfig } from "../src/config.js";
import { createContext, type AppContext } from "../src/context.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { actorFromPrincipal, getPrincipal } from "../src/domain/access.js";
import { ensureHuman, ensureOwnBoard } from "../src/domain/boards.js";
import { reply, startThread } from "../src/domain/conversation.js";
import type { Actor } from "../src/domain/model.js";
import { toOmbError } from "../src/errors.js";
import type { AppEnv } from "../src/http/util.js";
import { processOutbound, registerSyncRoutes, setSyncEndpoints, setSyncOptions, startSync } from "../src/sync/index.js";

// ---------- fake Slack, GitHub and Linear ----------

interface Call {
  platform: string;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const calls: Call[] = [];
/** Queued failures: the next matching call gets this response instead. */
const failures: { platform: string; path: string; status: number; json: unknown }[] = [];
let slackTs = 1700000500;
let githubCommentId = 7000;
let linearCommentId = 0;
let server: Server;
let tmp: string;

const LINEAR_ISSUE_ID = "0a1b2c3d-1111-4222-8333-444455556666";

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startFakes(): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://fake");
      const [, platform = "", ...rest] = url.pathname.split("/");
      const path = "/" + rest.join("/");
      calls.push({ platform, method: req.method ?? "GET", path, headers: req.headers, body });
      const fail = failures.findIndex((f) => f.platform === platform && f.path === path);
      if (fail >= 0) {
        const f = failures.splice(fail, 1)[0]!;
        return json(res, f.status, f.json);
      }
      if (platform === "slack") {
        const p = new URLSearchParams(body);
        if (path === "/auth.test") return json(res, 200, { ok: true, url: "https://acme.slack.com/", user_id: "UBOT", bot_id: "BBOT" });
        if (path === "/users.info") return json(res, 200, { ok: true, user: { name: "x", profile: { display_name: p.get("user") === "UADA" ? "Ada" : "Grace" } } });
        if (path === "/chat.getPermalink") {
          return json(res, 200, { ok: true, permalink: `https://acme.slack.com/archives/${p.get("channel")}/p${(p.get("message_ts") ?? "").replace(".", "")}` });
        }
        if (path === "/chat.postMessage") return json(res, 200, { ok: true, channel: p.get("channel"), ts: `${slackTs++}.000100` });
      }
      if (platform === "github") {
        if (path === "/user") return json(res, 200, { login: "board-sync-bot" });
        let m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
        if (m && req.method === "POST") {
          const id = githubCommentId++;
          return json(res, 201, { id, html_url: `https://github.com/${m[1]}/issues/${m[2]}#issuecomment-${id}` });
        }
        m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path);
        if (m && req.method === "GET") return json(res, 200, { number: Number(m[2]), html_url: `https://github.com/${m[1]}/issues/${m[2]}` });
        m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
        if (m && req.method === "POST") return json(res, 201, { id: 990042, number: 42, html_url: `https://github.com/${m[1]}/issues/42` });
      }
      if (platform === "linear") {
        const q = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        if (q.query.includes("viewer")) return json(res, 200, { data: { viewer: { id: "lin-bot" } } });
        if (q.query.includes("issue(id")) {
          return json(res, 200, { data: { issue: { id: LINEAR_ISSUE_ID, identifier: "ENG-12", url: "https://linear.app/acme/issue/ENG-12/fix-login" } } });
        }
        if (q.query.includes("commentCreate")) return json(res, 200, { data: { commentCreate: { success: true, comment: { id: `lin-comment-${++linearCommentId}` } } } });
      }
      json(res, 404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omb-sync-"));
  const base = await startFakes();
  setSyncEndpoints({ slack: `${base}/slack`, github: `${base}/github`, linear: `${base}/linear` });
  setSyncOptions({ retryBaseMs: 5, intervalMs: 25 });
});

after(() => {
  server.close();
  setSyncEndpoints(null);
  setSyncOptions(null);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- harness ----------

interface Harness {
  ctx: AppContext;
  app: Hono<AppEnv>;
  maya: Actor;
  boardId: string;
  stop: () => void;
}

async function harness(): Promise<Harness> {
  const db = openDatabase(":memory:");
  await migrate(db);
  const ctx = createContext(loadConfig({ ...process.env, OMB_DATA_DIR: tmp }, { dbPath: ":memory:", testMode: true }), db);
  const maya = actorFromPrincipal(ensureHuman(ctx, { email: "maya@example.com", displayName: "Maya" }), "session");
  const board = ensureOwnBoard(ctx, maya, { create: true })!;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-actor");
    const p = id ? getPrincipal(ctx, id) : undefined;
    c.set("actor", p ? actorFromPrincipal(p, "session") : null);
    await next();
  });
  registerSyncRoutes(app, ctx);
  app.onError((e, c) => {
    const err = toOmbError(e);
    return c.json({ error: err.toBody() }, err.status as ContentfulStatusCode);
  });
  return { ctx, app, maya, boardId: board.id, stop: startSync(ctx) };
}

async function api<T = Record<string, unknown>>(h: Harness, method: string, path: string, body?: unknown, actor: Actor | null = h.maya): Promise<{ status: number; json: T }> {
  const res = await h.app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(actor ? { "x-test-actor": actor.id } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function hook(h: Harness, url: string, body: string, headers: Record<string, string>) {
  const res = await h.app.request(new URL(url).pathname, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
const slackHeaders = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${hmac(secret, `v0:${ts}:${body}`)}`,
});
const githubHeaders = (secret: string, body: string, event: string) => ({ "x-hub-signature-256": `sha256=${hmac(secret, body)}`, "x-github-event": event });
const linearHeaders = (secret: string, body: string) => ({ "linear-signature": hmac(secret, body) });

function messages(h: Harness, threadId: string): Message[] {
  const rows = h.ctx.db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id").all(threadId) as { id: string }[];
  return rows.map((r) => {
    const m = h.ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(r.id) as Record<string, string | null>;
    return {
      id: m.id!,
      body: m.body ?? null,
      author_id: m.author_id,
      source: m.source_external_id
        ? { platform: m.source_platform, author_name: m.source_author_name, url: m.source_url, external_id: m.source_external_id }
        : null,
    } as unknown as Message;
  });
}

const callsTo = (platform: string, path: string) => calls.filter((c) => c.platform === platform && c.path === path);
const integrationRow = (h: Harness, id: string) =>
  h.ctx.db.prepare("SELECT last_error, last_event_at, principal_id FROM integrations WHERE id = ?").get(id) as {
    last_error: string | null;
    last_event_at: string | null;
    principal_id: string;
  };

const SLACK_SECRET = "slack-signing-secret-123";
const GITHUB_SECRET = "github-webhook-secret-123";
const LINEAR_SECRET = "linear-webhook-secret-123";
const ROOT_TS = "1700000000.000100";

async function createSlack(h: Harness, config: Record<string, unknown> = { channel_id: "C0SYNC01" }) {
  const res = await api<{ integration: Integration }>(h, "POST", `/api/boards/${h.boardId}/integrations`, {
    platform: "slack",
    name: "Team Slack",
    config,
    secrets: { bot_token: "xoxb-test-token-1", signing_secret: SLACK_SECRET },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.integration;
}

function slackEvent(event: Record<string, unknown>) {
  return JSON.stringify({ type: "event_callback", team_id: "T1", event_id: `Ev${Math.random()}`, event: { type: "message", channel: "C0SYNC01", ...event } });
}

// ---------- tests ----------

describe("integrations API", () => {
  let h: Harness;
  before(async () => (h = await harness()));
  after(() => h.stop());

  test("owners create, list and delete integrations; secrets are never returned", async () => {
    const created = await api<{ integration: Integration }>(h, "POST", `/api/boards/${h.boardId}/integrations`, {
      platform: "slack",
      name: "Team Slack",
      config: { channel_id: "c0sync01" },
      secrets: { bot_token: "xoxb-secret-value", signing_secret: SLACK_SECRET },
    });
    assert.equal(created.status, 200);
    const integration = created.json.integration;
    assert.equal(integration.platform, "slack");
    assert.deepEqual(integration.config, { channel_id: "C0SYNC01", auto_create_threads: true });
    assert.match(integration.webhook_url, /^http:\/\/localhost:\d+\/hooks\/slack\/[A-Za-z0-9_-]+$/);
    assert.ok(!JSON.stringify(created.json).includes("xoxb-secret-value"));
    assert.ok(!JSON.stringify(created.json).includes(SLACK_SECRET));

    const principalId = integrationRow(h, integration.id).principal_id;
    const principal = getPrincipal(h.ctx, principalId)!;
    assert.equal(principal.kind, "integration");
    assert.equal(principal.display_name, "Slack sync");
    assert.equal(principal.owner_id, h.maya.id);
    const membership = h.ctx.db.prepare("SELECT role FROM memberships WHERE board_id = ? AND principal_id = ?").get(h.boardId, principalId) as { role: string };
    assert.equal(membership.role, "contributor");

    const list = await api<{ integrations: Integration[] }>(h, "GET", `/api/boards/${h.boardId}/integrations`);
    assert.deepEqual(list.json.integrations.map((i) => i.id), [integration.id]);

    const del = await api(h, "DELETE", `/api/integrations/${integration.id}`);
    assert.deepEqual(del.json, { deleted: true });
    assert.equal(h.ctx.db.prepare("SELECT 1 FROM memberships WHERE board_id = ? AND principal_id = ?").get(h.boardId, principalId), undefined);
    assert.equal((await api<{ integrations: Integration[] }>(h, "GET", `/api/boards/${h.boardId}/integrations`)).json.integrations.length, 0);
  });

  test("rejects bad config, other people's boards and signed-out callers", async () => {
    const bad = await api<{ error: { code: string; message: string } }>(h, "POST", `/api/boards/${h.boardId}/integrations`, {
      platform: "github",
      name: "Repo",
      config: { repo: "not a repo" },
      secrets: { token: "ghp_test_token", webhook_secret: GITHUB_SECRET },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /config\.repo/);

    const ada = actorFromPrincipal(ensureHuman(h.ctx, { email: "ada@example.com", displayName: "Ada" }), "session");
    const other = await api(h, "GET", `/api/boards/${h.boardId}/integrations`, undefined, ada);
    assert.equal(other.status, 404);
    const anon = await api(h, "GET", `/api/boards/${h.boardId}/integrations`, undefined, null);
    assert.equal(anon.status, 401);
  });
});

describe("Slack sync", () => {
  let h: Harness;
  let integration: Integration;
  let threadId: string;
  let link: ExternalLink;
  before(async () => {
    h = await harness();
    integration = await createSlack(h);
    threadId = startThread(h.ctx, h.maya, h.boardId, { title: "Launch checklist", body: "What is left before launch?" }).thread.id;
  });
  after(() => h.stop());

  test("rejects bad signatures and stale timestamps", async () => {
    const body = slackEvent({ user: "UADA", ts: "1700000001.000001", text: "hi" });
    const forged = await hook(h, integration.webhook_url, body, slackHeaders("wrong-secret-value", body));
    assert.equal(forged.status, 401);
    const stale = await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body, Math.floor(Date.now() / 1000) - 600));
    assert.equal(stale.status, 401);
    const missing = await hook(h, integration.webhook_url, body, {});
    assert.equal(missing.status, 401);
    const unknown = await hook(h, integration.webhook_url.replace(/[^/]+$/, "nope"), body, slackHeaders(SLACK_SECRET, body));
    assert.equal(unknown.status, 404);
  });

  test("answers url_verification with the challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", token: "x", challenge: "challenge-abc" });
    const res = await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { challenge: "challenge-abc" });
  });

  test("links an existing Slack thread", async () => {
    const res = await api<{ link: ExternalLink }>(h, "POST", `/api/threads/${threadId}/links`, {
      integration_id: integration.id,
      external_ref: `C0SYNC01/${ROOT_TS}`,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    link = res.json.link;
    assert.equal(link.platform, "slack");
    assert.equal(link.external_ref, `C0SYNC01/${ROOT_TS}`);
    assert.equal(link.url, "https://acme.slack.com/archives/C0SYNC01/p1700000000000100");
  });

  test("a threaded Slack reply lands in the board thread with its source, once", async () => {
    const posted = callsTo("slack", "/chat.postMessage").length;
    const body = slackEvent({ user: "UADA", ts: "1700000002.000200", thread_ts: ROOT_TS, text: "Docs are done, thanks <@UGRACE> &amp; team" });
    const first = await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body));
    assert.equal(first.status, 200);
    const msgs = messages(h, threadId);
    const synced = msgs[msgs.length - 1]!;
    assert.equal(synced.body, "Docs are done, thanks @Grace & team");
    assert.deepEqual(synced.source, {
      platform: "slack",
      author_name: "Ada",
      url: "https://acme.slack.com/archives/C0SYNC01/p1700000002000200?thread_ts=1700000000.000100&cid=C0SYNC01",
      external_id: "1700000002.000200",
    });
    assert.equal(getPrincipal(h.ctx, (synced as unknown as { author_id: string }).author_id)!.kind, "integration");

    const retry = await hook(h, integration.webhook_url, body, { ...slackHeaders(SLACK_SECRET, body), "x-slack-retry-num": "1" });
    assert.equal(retry.status, 200);
    assert.equal(messages(h, threadId).length, msgs.length);

    await processOutbound(h.ctx);
    assert.equal(callsTo("slack", "/chat.postMessage").length, posted, "an inbound Slack message is not echoed back to Slack");
    assert.ok(integrationRow(h, integration.id).last_event_at);
  });

  test("a board reply is posted to Slack once with the author line and its echo is ignored", async () => {
    const before = callsTo("slack", "/chat.postMessage").length;
    const { message } = reply(h.ctx, h.maya, threadId, { body: "Ship it **today**" });
    await processOutbound(h.ctx);
    await processOutbound(h.ctx);
    const sent = callsTo("slack", "/chat.postMessage").slice(before);
    assert.equal(sent.length, 1);
    const params = new URLSearchParams(sent[0]!.body);
    assert.equal(params.get("channel"), "C0SYNC01");
    assert.equal(params.get("thread_ts"), ROOT_TS);
    assert.equal(params.get("text"), "*Maya*: Ship it *today*");
    assert.equal(sent[0]!.headers.authorization, "Bearer xoxb-test-token-1");
    const row = h.ctx.db.prepare("SELECT status, external_id FROM sync_outbound WHERE message_id = ?").get(message.id) as { status: string; external_id: string };
    assert.equal(row.status, "sent");

    const count = messages(h, threadId).length;
    const echo = slackEvent({ user: "UBOT", bot_id: "BBOT", ts: row.external_id, thread_ts: ROOT_TS, text: "*Maya*: Ship it *today*" });
    assert.equal((await hook(h, integration.webhook_url, echo, slackHeaders(SLACK_SECRET, echo))).status, 200);
    const noBotId = slackEvent({ user: "UOTHER", ts: row.external_id, thread_ts: ROOT_TS, text: "same message" });
    assert.equal((await hook(h, integration.webhook_url, noBotId, slackHeaders(SLACK_SECRET, noBotId))).status, 200);
    const edit = slackEvent({ subtype: "message_changed", ts: "1700000003.000300", thread_ts: ROOT_TS, message: { text: "edited" } });
    assert.equal((await hook(h, integration.webhook_url, edit, slackHeaders(SLACK_SECRET, edit))).status, 200);
    assert.equal(messages(h, threadId).length, count);
  });

  test("a new top-level message in the channel starts and links a board thread", async () => {
    const text = "Deploy plan for Friday\nRoll out to 10% first.";
    const body = slackEvent({ user: "UADA", ts: "1700000010.000100", text });
    const res = await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body));
    assert.equal(res.status, 200);
    const newThreadId = res.json.thread_id as string;
    const thread = h.ctx.db.prepare("SELECT title FROM threads WHERE id = ?").get(newThreadId) as { title: string };
    assert.equal(thread.title, "Deploy plan for Friday");
    const [root] = messages(h, newThreadId);
    assert.equal(root!.body, text);
    assert.equal(root!.source!.external_id, "1700000010.000100");
    const newLink = h.ctx.db.prepare("SELECT external_ref FROM thread_links WHERE thread_id = ?").get(newThreadId) as { external_ref: string };
    assert.equal(newLink.external_ref, "C0SYNC01/1700000010.000100");

    const threads = (h.ctx.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
    await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body));
    assert.equal((h.ctx.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n, threads, "a redelivered event doesn't create a second thread");

    const long = "x".repeat(120);
    const longBody = slackEvent({ user: "UADA", ts: "1700000011.000100", text: long });
    const longRes = await hook(h, integration.webhook_url, longBody, slackHeaders(SLACK_SECRET, longBody));
    const longTitle = (h.ctx.db.prepare("SELECT title FROM threads WHERE id = ?").get(longRes.json.thread_id) as { title: string }).title;
    assert.equal([...longTitle].length, 80);

    const elsewhere = slackEvent({ user: "UADA", ts: "1700000012.000100", text: "other channel", channel: "C0OTHER1" });
    assert.equal((await hook(h, integration.webhook_url, elsewhere, slackHeaders(SLACK_SECRET, elsewhere))).json.ignored, "not_synced");
    const bot = slackEvent({ user: "UZAP", bot_id: "BZAP", ts: "1700000013.000100", text: "build passed" });
    assert.equal((await hook(h, integration.webhook_url, bot, slackHeaders(SLACK_SECRET, bot))).json.ignored, "bot");
    assert.equal((h.ctx.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n, threads + 1);
  });

  test("failed sends are retried with backoff, then marked failed", async () => {
    failures.push({ platform: "slack", path: "/chat.postMessage", status: 200, json: { ok: false, error: "ratelimited" } });
    failures.push({ platform: "slack", path: "/chat.postMessage", status: 503, json: {} });
    const before = callsTo("slack", "/chat.postMessage").length;
    const { message } = reply(h.ctx, h.maya, threadId, { body: "Retry me" });
    for (let i = 0; i < 20; i++) {
      await processOutbound(h.ctx);
      const row = h.ctx.db.prepare("SELECT status FROM sync_outbound WHERE message_id = ?").get(message.id) as { status: string };
      if (row.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    const row = h.ctx.db.prepare("SELECT status, attempts FROM sync_outbound WHERE message_id = ?").get(message.id) as { status: string; attempts: number };
    assert.deepEqual(row, { status: "sent", attempts: 3 });
    assert.equal(callsTo("slack", "/chat.postMessage").length - before, 3);
    assert.equal(integrationRow(h, integration.id).last_error, null);

    failures.push({ platform: "slack", path: "/chat.postMessage", status: 200, json: { ok: false, error: "not_in_channel" } });
    const { message: second } = reply(h.ctx, h.maya, threadId, { body: "Nobody will see this" });
    await processOutbound(h.ctx);
    const failed = h.ctx.db.prepare("SELECT status, attempts FROM sync_outbound WHERE message_id = ?").get(second.id) as { status: string; attempts: number };
    assert.deepEqual(failed, { status: "failed", attempts: 1 });
    assert.match(integrationRow(h, integration.id).last_error ?? "", /not_in_channel/);
  });

  test("an inbound message over the board's post quota is recorded as last_error and acknowledged", async () => {
    const used = (h.ctx.db.prepare("SELECT posts FROM usage_monthly WHERE board_id = ?").get(h.boardId) as { posts: number }).posts;
    h.ctx.config.limits.posts_per_month = used;
    const count = messages(h, threadId).length;
    const body = slackEvent({ user: "UADA", ts: "1700000020.000100", thread_ts: ROOT_TS, text: "Over the limit" });
    const res = await hook(h, integration.webhook_url, body, slackHeaders(SLACK_SECRET, body));
    assert.equal(res.status, 200);
    assert.equal(res.json.skipped, "quota_exceeded");
    assert.equal(messages(h, threadId).length, count);
    assert.match(integrationRow(h, integration.id).last_error ?? "", /posts for this month/);
  });
});

describe("GitHub sync", () => {
  let h: Harness;
  let integration: Integration;
  let threadId: string;
  before(async () => {
    h = await harness();
    const res = await api<{ integration: Integration }>(h, "POST", `/api/boards/${h.boardId}/integrations`, {
      platform: "github",
      name: "Web repo",
      config: { repo: "acme/web" },
      secrets: { token: "ghp_test_token_1", webhook_secret: GITHUB_SECRET },
    });
    integration = res.json.integration;
    threadId = startThread(h.ctx, h.maya, h.boardId, { title: "Login bug", body: "Login fails on Safari" }).thread.id;
  });
  after(() => h.stop());

  test("links an issue, imports comments, and skips its own", async () => {
    const linked = await api<{ link: ExternalLink }>(h, "POST", `/api/threads/${threadId}/links`, { integration_id: integration.id, external_ref: "Acme/Web#7" });
    assert.equal(linked.status, 200, JSON.stringify(linked.json));
    assert.deepEqual(
      { ref: linked.json.link.external_ref, url: linked.json.link.url },
      { ref: "acme/web#7", url: "https://github.com/Acme/Web/issues/7" },
    );

    const comment = (id: number, login: string, body: string) =>
      JSON.stringify({
        action: "created",
        repository: { full_name: "acme/web" },
        issue: { number: 7 },
        comment: { id, body, user: { login }, html_url: `https://github.com/acme/web/issues/7#issuecomment-${id}` },
      });

    const forged = comment(1, "jordan-k", "hi");
    assert.equal((await hook(h, integration.webhook_url, forged, githubHeaders("wrong-secret-xx", forged, "issue_comment"))).status, 401);

    const body = comment(555, "jordan-k", "Repro steps attached.");
    const res = await hook(h, integration.webhook_url, body, githubHeaders(GITHUB_SECRET, body, "issue_comment"));
    assert.equal(res.status, 200);
    const last = messages(h, threadId).at(-1)!;
    assert.equal(last.body, "Repro steps attached.");
    assert.deepEqual(last.source, { platform: "github", author_name: "jordan-k", url: "https://github.com/acme/web/issues/7#issuecomment-555", external_id: "555" });

    const count = messages(h, threadId).length;
    await hook(h, integration.webhook_url, body, githubHeaders(GITHUB_SECRET, body, "issue_comment"));
    const own = comment(556, "board-sync-bot", "posted by the sync");
    await hook(h, integration.webhook_url, own, githubHeaders(GITHUB_SECRET, own, "issue_comment"));
    const marked = comment(557, "someone-else", "copy\n\n<!-- omb:m_123 -->");
    await hook(h, integration.webhook_url, marked, githubHeaders(GITHUB_SECRET, marked, "issue_comment"));
    assert.equal(messages(h, threadId).length, count);

    const ping = JSON.stringify({ zen: "Keep it simple." });
    assert.equal((await hook(h, integration.webhook_url, ping, githubHeaders(GITHUB_SECRET, ping, "ping"))).status, 200);
  });

  test("board replies become issue comments with the author line and marker", async () => {
    const before = calls.filter((c) => c.platform === "github" && c.path === "/repos/acme/web/issues/7/comments").length;
    const { message } = reply(h.ctx, h.maya, threadId, { body: "Fixed in the next release." });
    await processOutbound(h.ctx);
    const sent = calls.filter((c) => c.platform === "github" && c.path === "/repos/acme/web/issues/7/comments").slice(before);
    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0]!.body) as { body: string };
    assert.match(payload.body, /^\*\*Maya\*\* on \[OpenMessageBoard\]\(http:\/\/localhost:\d+\/b\/[^)]+\):\n\nFixed in the next release\./);
    assert.ok(payload.body.endsWith(`<!-- omb:${message.id} -->`));
    assert.equal(sent[0]!.headers.authorization, "Bearer ghp_test_token_1");
  });

  test("linking without a reference creates an issue from the thread", async () => {
    const other = startThread(h.ctx, h.maya, h.boardId, { title: "Dark mode", body: "Can we add a dark theme?" }).thread.id;
    const res = await api<{ link: ExternalLink }>(h, "POST", `/api/threads/${other}/links`, { integration_id: integration.id });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.link.external_ref, "acme/web#42");
    const created = calls.filter((c) => c.platform === "github" && c.path === "/repos/acme/web/issues" && c.method === "POST").at(-1)!;
    const issue = JSON.parse(created.body) as { title: string; body: string };
    assert.equal(issue.title, "Dark mode");
    assert.match(issue.body, /Can we add a dark theme\?/);
    assert.match(issue.body, /<!-- omb:m_/);
    const before = calls.length;
    await processOutbound(h.ctx);
    assert.equal(calls.length, before, "the first message is not sent again as a comment");

    const dup = await api<{ error: { code: string } }>(h, "POST", `/api/threads/${other}/links`, { integration_id: integration.id });
    assert.equal(dup.status, 409);
  });
});

describe("Linear sync", () => {
  let h: Harness;
  let integration: Integration;
  let threadId: string;
  before(async () => {
    h = await harness();
    const res = await api<{ integration: Integration }>(h, "POST", `/api/boards/${h.boardId}/integrations`, {
      platform: "linear",
      name: "Engineering",
      config: { team_key: "eng" },
      secrets: { api_key: "lin_api_test_key", webhook_secret: LINEAR_SECRET },
    });
    integration = res.json.integration;
    assert.equal(integration.config.team_key, "ENG");
    threadId = startThread(h.ctx, h.maya, h.boardId, { title: "Fix login", body: "Tracking the login fix" }).thread.id;
    const linked = await api<{ link: ExternalLink }>(h, "POST", `/api/threads/${threadId}/links`, { integration_id: integration.id, external_ref: "eng-12" });
    assert.equal(linked.json.link.external_ref, "ENG-12");
  });
  after(() => h.stop());

  const commentEvent = (id: string, userId: string, body: string, at = Date.now()) =>
    JSON.stringify({
      action: "create",
      type: "Comment",
      data: { id, body, issueId: LINEAR_ISSUE_ID, userId, user: { id: userId, name: "Priya" } },
      actor: { id: userId, type: "user", name: "Priya" },
      url: `https://linear.app/acme/issue/ENG-12#comment-${id}`,
      webhookTimestamp: at,
    });

  test("a Linear comment becomes a reply; stale, forged and own comments are not", async () => {
    const stale = commentEvent("c-0", "lin-user-1", "old", Date.now() - 5 * 60_000);
    assert.equal((await hook(h, integration.webhook_url, stale, linearHeaders(LINEAR_SECRET, stale))).status, 401);
    const body = commentEvent("c-1", "lin-user-1", "Deployed to staging.");
    assert.equal((await hook(h, integration.webhook_url, body, linearHeaders("wrong-secret-xx", body))).status, 401);

    const res = await hook(h, integration.webhook_url, body, linearHeaders(LINEAR_SECRET, body));
    assert.equal(res.status, 200);
    const last = messages(h, threadId).at(-1)!;
    assert.equal(last.body, "Deployed to staging.");
    assert.deepEqual(last.source, { platform: "linear", author_name: "Priya", url: "https://linear.app/acme/issue/ENG-12#comment-c-1", external_id: "c-1" });

    const count = messages(h, threadId).length;
    const own = commentEvent("c-2", "lin-bot", "**Maya** on OpenMessageBoard: hi");
    await hook(h, integration.webhook_url, own, linearHeaders(LINEAR_SECRET, own));
    await hook(h, integration.webhook_url, body, linearHeaders(LINEAR_SECRET, body));
    assert.equal(messages(h, threadId).length, count);
  });

  test("board replies become Linear comments on the linked issue", async () => {
    const before = callsTo("linear", "/").length;
    reply(h.ctx, h.maya, threadId, { body: "Thanks, closing after QA." });
    await processOutbound(h.ctx);
    const sent = callsTo("linear", "/").slice(before).map((c) => JSON.parse(c.body) as { query: string; variables: { input: { issueId: string; body: string } } });
    const comments = sent.filter((q) => q.query.includes("commentCreate"));
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.variables.input.issueId, LINEAR_ISSUE_ID);
    assert.match(comments[0]!.variables.input.body, /^\*\*Maya\*\* on \[OpenMessageBoard\]\([^)]+\):\n\nThanks, closing after QA\.$/);
    assert.equal(callsTo("linear", "/").at(-1)!.headers.authorization, "lin_api_test_key");
  });
});

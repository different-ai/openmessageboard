import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { apiScopeNeed } from "@openmessageboard/core/auth/scopes";
import { freePort, key } from "./helpers.ts";

/**
 * The web API routes the browser client uses for channel subscriptions and public boards: the caller's
 * subscriptions on a board, saving and unsaving a public board, and what the other routes answer to someone who
 * reads a board through a public grant.
 */
let running: Running;
let base: string;
const tokens: Record<string, string> = {};
let boardId: string;

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-web-api-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
  for (const [name, email] of [["owner", "owner@example.test"], ["maya", "maya@example.test"], ["outsider", "out@elsewhere.test"]] as const) {
    tokens[name] = mintToken(running.ctx, ensureHuman(running.ctx, { email, displayName: name }).id, "test").token;
  }
  boardId = (await json<{ board: { id: string } }>("owner", "POST", "/api/boards", {})).board.id;
  const { invite } = await json<{ invite: { url: string } }>("owner", "POST", `/api/boards/${boardId}/invites`, { audience: "email", value: "maya@example.test", role: "contributor" });
  await json("maya", "POST", `/api/invite-links/${invite.url.split("/").pop()}/redeem`, {});
});

after(async () => {
  await running.stop();
});

/** Calls the web API as `who` (a name in `tokens`, a raw token, or null for no credential). */
async function api(who: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${tokens[who] ?? who}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function json<T = Record<string, unknown>>(who: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await api(who, method, path, body);
  const text = await res.text();
  assert.equal(res.status, 200, `${method} ${path} as ${who}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/** The status and error code of a call that should fail. */
async function refused(who: string | null, method: string, path: string, body?: unknown): Promise<[number, string]> {
  const res = await api(who, method, path, body);
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return [res.status, data.error?.code ?? ""];
}

const post = (who: string, channel: string, title: string) =>
  json<{ thread: { id: string }; message: { id: string } }>(who, "POST", `/api/boards/${boardId}/threads`, { channel, title, body: `${title} body`, idempotency_key: key() });

type Sub = { board_id: string; pattern: string; level: string; created_at: string };
const subs = async (who: string) => (await json<{ subscriptions: Sub[] }>(who, "GET", `/api/boards/${boardId}/subscriptions`)).subscriptions.map((s) => [s.pattern, s.level]);

test("subscriptions: a member sets, lists and removes them, and a thread in a subscribed channel reaches the inbox", async () => {
  const path = `/api/boards/${boardId}/subscriptions`;
  assert.deepEqual(await subs("maya"), []);
  const set = await json<{ subscription: Sub }>("maya", "PUT", path, { pattern: "support/", level: "threads" });
  assert.deepEqual([set.subscription.board_id, set.subscription.pattern, set.subscription.level], [boardId, "support/", "threads"]);
  await json("maya", "PUT", path, { pattern: "*", level: "mute" });
  assert.deepEqual(await subs("maya"), [
    ["*", "mute"],
    ["support/", "threads"],
  ]);
  // Subscriptions are the caller's own: the owner has none.
  assert.deepEqual(await subs("owner"), []);

  const started = await post("owner", "support/billing", "Refund request");
  await post("owner", "chatter", "Lunch");
  const inbox = await json<{ items: { kind: string; thread_id: string; message: { id: string } | null }[] }>("maya", "GET", "/api/inbox");
  assert.deepEqual(
    inbox.items.map((i) => [i.kind, i.thread_id, i.message?.id]),
    [["thread", started.thread.id, started.message.id]],
  );

  // Setting the same pattern again replaces its level; level: null removes it.
  assert.equal((await json<{ subscription: Sub }>("maya", "PUT", path, { pattern: "support/", level: "all" })).subscription.level, "all");
  assert.equal((await json<{ subscription: Sub | null }>("maya", "PUT", path, { pattern: "support/", level: null })).subscription, null);
  assert.deepEqual(await subs("maya"), [["*", "mute"]]);
  await json("maya", "PUT", path, { pattern: "*", level: null });

  // The body is validated like the tool's input.
  assert.deepEqual(await refused("maya", "PUT", path, { pattern: "Not A Channel", level: "all" }), [400, "invalid_argument"]);
  assert.deepEqual(await refused("maya", "PUT", path, { pattern: "support/", level: "loud" }), [400, "invalid_argument"]);
  assert.deepEqual(await refused("maya", "PUT", path, { pattern: "support/" }), [400, "invalid_argument"]);
  // No credential, and someone who is not a member of a board that is not public.
  assert.deepEqual(await refused(null, "GET", path), [401, "unauthenticated"]);
  assert.deepEqual(await refused("outsider", "GET", path), [404, "not_found"]);
  assert.deepEqual(await refused("outsider", "PUT", path, { pattern: "*", level: "all" }), [404, "not_found"]);
});

test("subscriptions and saved boards with a scoped token: an inbox preference is a read, saving a board is never allowed", async () => {
  // Classified like the tools: set_subscription and list_subscriptions are reads; save_board and unsave_board are not for scoped tokens.
  assert.equal(apiScopeNeed("GET", "/api/boards/b_1/subscriptions"), "read");
  assert.equal(apiScopeNeed("PUT", "/api/boards/b_1/subscriptions"), "read");
  assert.equal(apiScopeNeed("PUT", "/api/boards/b_1/saved"), "manage");
  assert.equal(apiScopeNeed("DELETE", "/api/boards/b_1/saved"), "manage");

  const readOnly = (await json<{ token: string }>("maya", "POST", "/api/tokens", { label: "ro", boards: [boardId], can: ["read"], expires_in_seconds: 600 })).token;
  const path = `/api/boards/${boardId}/subscriptions`;
  assert.equal((await json<{ subscription: Sub }>(readOnly, "PUT", path, { pattern: "incidents", level: "all" })).subscription.level, "all");
  assert.deepEqual((await json<{ subscriptions: Sub[] }>(readOnly, "GET", path)).subscriptions.map((s) => s.pattern), ["incidents"]);
  await json(readOnly, "PUT", path, { pattern: "incidents", level: null });
  assert.deepEqual(await refused(readOnly, "PUT", `/api/boards/${boardId}/saved`), [403, "forbidden"]);
  assert.deepEqual(await refused(readOnly, "DELETE", `/api/boards/${boardId}/saved`), [403, "forbidden"]);

  // A token limited to another board sees this one as if it did not exist.
  const mayaBoard = (await json<{ board: { id: string } }>("maya", "POST", "/api/boards", {})).board.id;
  const elsewhere = (await json<{ token: string }>("maya", "POST", "/api/tokens", { label: "other", boards: [mayaBoard], can: ["read"], expires_in_seconds: 600 })).token;
  assert.deepEqual(await refused(elsewhere, "GET", path), [404, "not_found"]);
  assert.deepEqual(await refused(elsewhere, "PUT", path, { pattern: "*", level: "all" }), [404, "not_found"]);
});

test("public boards: the owner opens a channel, someone who is not a member reads it and saves the board, and nothing else", async () => {
  const board = `/api/boards/${boardId}`;
  const news = await post("owner", "announcements", "Release 2.0");
  const dev = await post("owner", "dev", "Roadmap");

  // Not public yet: the address tells an outsider nothing, and there is nothing to save.
  assert.deepEqual(await refused("outsider", "GET", board), [404, "not_found"]);
  assert.deepEqual(await refused("outsider", "PUT", `${board}/saved`), [404, "not_found"]);

  // Only the owner makes a public grant; it gives read or nothing.
  const grant = { principals: [{ kind: "public" }], can: { "announcements/": ["read"] } };
  assert.deepEqual(await refused("maya", "POST", `${board}/grants`, grant), [403, "forbidden"]);
  assert.deepEqual(await refused("owner", "POST", `${board}/grants`, { principals: [{ kind: "public" }], can: { "announcements/": ["read", "post"] } }), [400, "invalid_argument"]);
  const before = (await json<{ cursor: string }>("owner", "GET", `${board}/changes`)).cursor;
  const made = await json<{ grant: { id: string; principals: { kind: string }[] } }>("owner", "POST", `${board}/grants`, grant);
  assert.deepEqual(made.grant.principals, [{ kind: "public" }]);

  // Members see that the board and the channel are public.
  assert.equal((await json<{ visibility: string }>("maya", "GET", board)).visibility, "public");
  const forMaya = (await json<{ channels: { path: string; public: boolean }[] }>("maya", "GET", `${board}/channels`)).channels;
  assert.deepEqual(forMaya.filter((c) => c.public).map((c) => c.path), ["announcements"]);

  // The outsider reads the board as the public: no role, the public channels, their threads and messages.
  const seen = await json<{ visibility: string; my_access: string; my_role: string | null }>("outsider", "GET", board);
  assert.deepEqual([seen.visibility, seen.my_access, seen.my_role], ["public", "public", null]);
  const channels = (await json<{ channels: { path: string; public: boolean; my_permissions: string[] }[] }>("outsider", "GET", `${board}/channels`)).channels;
  assert.deepEqual(channels.map((c) => [c.path, c.public, c.my_permissions]), [["announcements", true, ["read"]]]);
  assert.deepEqual((await json<{ threads: { id: string }[] }>("outsider", "GET", `${board}/threads`)).threads.map((t) => t.id), [news.thread.id]);
  assert.equal((await json<{ messages: { body: string }[] }>("outsider", "GET", `/api/threads/${news.thread.id}`)).messages[0]!.body, "Release 2.0 body");
  assert.deepEqual(await refused("outsider", "GET", `/api/threads/${dev.thread.id}`), [404, "not_found"]);

  // No live stream for the public: they catch up by polling changes, which carry public channels only.
  assert.deepEqual(await refused("outsider", "GET", `${board}/stream`), [403, "forbidden"]);
  const second = await post("owner", "announcements", "Release 2.1");
  await post("owner", "dev", "More roadmap");
  const page = await json<{ changes: { type: string; thread_id: string }[]; cursor: string; has_more: boolean }>("outsider", "GET", `${board}/changes?cursor=${encodeURIComponent(before)}`);
  assert.deepEqual(page.changes.map((c) => [c.type, c.thread_id]), [["thread.created", second.thread.id]]);

  // Everything that writes, and everything about the members, is forbidden.
  assert.deepEqual(await refused("outsider", "POST", `${board}/threads`, { title: "Hi", body: "hello", idempotency_key: key() }), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "POST", `/api/threads/${news.thread.id}/messages`, { body: "hello", idempotency_key: key() }), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "PUT", `/api/threads/${news.thread.id}/follow`, { following: true }), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "GET", `${board}/members`), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "GET", `${board}/grants`), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "GET", `${board}/subscriptions`), [403, "forbidden"]);
  assert.deepEqual(await refused("outsider", "PUT", `${board}/subscriptions`, { pattern: "*", level: "all" }), [403, "forbidden"]);

  // An agent reads a public board only after its person saved it, and never saves one itself.
  const agent = (await json<{ agent: { id: string } }>("outsider", "POST", "/api/agents", { display_name: "reader-bot" })).agent;
  const agentToken = (await json<{ token: string }>("outsider", "POST", `/api/agents/${agent.id}/tokens`, {})).token;
  assert.deepEqual(await refused(agentToken, "GET", board), [404, "not_found"]);
  assert.deepEqual(await refused(agentToken, "PUT", `${board}/saved`), [403, "forbidden"]);
  assert.deepEqual((await json<{ saved_boards: unknown[] }>("outsider", "GET", "/api/me")).saved_boards, []);

  const saved = await json<{ board: { id: string; my_access: string; my_role: string | null } }>("outsider", "PUT", `${board}/saved`);
  assert.deepEqual([saved.board.id, saved.board.my_access, saved.board.my_role], [boardId, "public", null]);
  await json("outsider", "PUT", `${board}/saved`); // saving twice is the same as saving once
  assert.deepEqual((await json<{ saved_boards: { id: string }[] }>("outsider", "GET", "/api/me")).saved_boards.map((b) => b.id), [boardId]);
  assert.equal((await json<{ my_access: string }>(agentToken, "GET", board)).my_access, "public");
  assert.deepEqual((await json<{ saved_boards: { id: string }[] }>(agentToken, "GET", "/api/me")).saved_boards.map((b) => b.id), [boardId]);
  assert.deepEqual(await refused(agentToken, "DELETE", `${board}/saved`), [403, "forbidden"]);

  // Unsaving answers the same whether or not the board was saved, and takes the agent's access with it.
  assert.deepEqual(await json("outsider", "DELETE", `${board}/saved`), { board_id: boardId, saved: false });
  assert.deepEqual(await json("outsider", "DELETE", `${board}/saved`), { board_id: boardId, saved: false });
  assert.deepEqual((await json<{ saved_boards: unknown[] }>("outsider", "GET", "/api/me")).saved_boards, []);
  assert.deepEqual(await refused(agentToken, "GET", board), [404, "not_found"]);
  assert.deepEqual(await refused(null, "PUT", `${board}/saved`), [401, "unauthenticated"]);

  // Revoking the public grant makes the board private again, saved or not.
  await json("outsider", "PUT", `${board}/saved`);
  assert.deepEqual(await refused("maya", "DELETE", `/api/grants/${made.grant.id}`), [404, "not_found"]);
  await json("owner", "DELETE", `/api/grants/${made.grant.id}`);
  assert.equal((await json<{ visibility: string }>("owner", "GET", board)).visibility, "private");
  assert.deepEqual(await refused("outsider", "GET", board), [404, "not_found"]);
  assert.deepEqual(await refused("outsider", "GET", `${board}/changes?cursor=${encodeURIComponent(page.cursor)}`), [404, "not_found"]);
  assert.deepEqual((await json<{ saved_boards: unknown[] }>("outsider", "GET", "/api/me")).saved_boards, []);
});

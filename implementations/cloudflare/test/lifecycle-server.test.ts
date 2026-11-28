import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, loadConfig, type AppContext, type Booted } from "@openmessageboard/core";
import { mintTestIdentities } from "@openmessageboard/core/domain/test-identities";
import { exportBoard } from "@openmessageboard/core/domain/portability";
import { limitsFor } from "@openmessageboard/core/domain/plans";
import { OmbError } from "@openmessageboard/core/errors";
import { z } from "zod";
// The real core on the Node runtime's SQLite: the same domain code and SQL the Worker runs.
import { migrate, openDatabase } from "../../node/src/db/index.ts";
import { nodePlatform } from "../../node/src/platform.ts";
import { LIFECYCLE_EXTENSION_ID, lifecycleSettings, linkToken } from "../src/lifecycle.ts";
import { LIFECYCLE_MIGRATION, boardSnapshot, deactivateIfInactive, isSynced, lifecycleExtension, markSynced, recordSignIns, unsyncedBoards, type LifecycleCore } from "../src/lifecycle-server.ts";

const DAY = 86_400_000;
const BASE = "http://omb.test";
const settings = lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "90" })!;
const core = { exportBoard, limitsFor, error: (code: never, message: string) => new OmbError(code, message) } as unknown as LifecycleCore;

const nudged: string[] = [];
const extension = lifecycleExtension({ settings, core, nudge: async (id) => void nudged.push(id) });
let booted: Booted;
let ctx: AppContext;
let offset = 0;
let tokens: Record<string, Record<string, string>>;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-lifecycle-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PUBLIC_URL: BASE, OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_LIMIT_BOARDS_OWNED: "1" }, { dbPath: ":memory:" });
  const db = openDatabase(":memory:");
  await migrate(db, [LIFECYCLE_MIGRATION]);
  booted = await bootServer({
    config,
    db,
    platform: nodePlatform(dir),
    features: { sync: false, extensions: [extension] },
    now: () => new Date(Date.now() + offset),
  });
  ctx = booted.ctx;
  tokens = mintTestIdentities(ctx).principals;
});

type Res = { status: number; json: any; text: string; headers: Headers };
async function call(method: string, path: string, opts: { as?: string; cookie?: string; json?: unknown; form?: Record<string, string>; origin?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.as) headers.authorization = `Bearer ${tokens[opts.as]!.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  let body: string | undefined;
  if (opts.json !== undefined) [headers["content-type"], body] = ["application/json", JSON.stringify(opts.json)];
  if (opts.form) [headers["content-type"], body] = ["application/x-www-form-urlencoded", new URLSearchParams(opts.form).toString()];
  const res = await booted.app.request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a page */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function ownBoard(as: string): Promise<string> {
  const res = await call("POST", "/api/boards", { as, json: {} });
  assert.equal(res.status, 200, res.text);
  return res.json.board.id;
}
let n = 0;
const post = (as: string, boardId: string, title = "Hello") => call("POST", `/api/boards/${boardId}/threads`, { as, json: { title, body: "First message", idempotency_key: `k-${++n}` } });
async function addMember(boardId: string, owner: string, member: string): Promise<void> {
  const invite = await call("POST", `/api/boards/${boardId}/invites`, { as: owner, json: { audience: "link", role: "contributor" } });
  assert.equal(invite.status, 200, invite.text);
  const token = String(invite.json.invite.url ?? invite.json.invite.token).split("/").pop()!;
  const redeemed = await call("POST", `/api/invite-links/${token}/redeem`, { as: member });
  assert.equal(redeemed.status, 200, redeemed.text);
}

test("the extension is listed in discovery under the implementation's namespace", async () => {
  const info = (await call("GET", "/.well-known/openmessageboard")).json;
  assert.match(LIFECYCLE_EXTENSION_ID, /^openmessageboard\.cloudflare\/[a-z0-9-]+$/);
  assert.equal(info.extensions[LIFECYCLE_EXTENSION_ID].version, "0.1.0");
  assert.match(info.extensions[LIFECYCLE_EXTENSION_ID].description, /90 days/);
});

test("activity is a post on the board, by anyone; reading is not", async () => {
  offset = 0;
  const boardId = await ownBoard("owner");
  await addMember(boardId, "owner", "maya");
  const created = boardSnapshot(ctx, boardId);
  assert.deepEqual([created.exists, created.name.length > 0, created.owner_email, created.deactivated_at, created.disabled], [true, true, "owner@example.test", null, false]);

  offset = 10 * DAY;
  assert.equal((await call("GET", `/api/boards/${boardId}/threads`, { as: "maya" })).status, 200);
  assert.equal((await call("GET", `/api/boards/${boardId}/threads`, { as: "owner" })).status, 200);
  assert.equal(boardSnapshot(ctx, boardId).active_at, created.active_at, "reads move nothing");

  assert.equal((await post("maya", boardId)).status, 200);
  const after = Date.parse(boardSnapshot(ctx, boardId).active_at);
  assert.ok(Math.abs(after - (Date.now() + 10 * DAY)) < 5000, "a member's post is activity");
});

test("the owner signing in is activity, and still counts after signing out", async () => {
  offset = 0;
  const email = "quota@example.test";
  const boardId = await ownBoard("quota");
  const before = boardSnapshot(ctx, boardId).active_at;

  const json = { "content-type": "application/json", origin: BASE };
  const send = await booted.app.request(`${BASE}/api/sign-in/start`, { method: "POST", headers: json, body: JSON.stringify({ email }) });
  assert.equal(send.status, 200, await send.clone().text());
  const code = (await call("GET", `/api/test/outbox?email=${encodeURIComponent(email)}`)).json.messages[0].code;
  await new Promise((r) => setTimeout(r, 20));
  const signedIn = await booted.app.request(`${BASE}/api/auth/sign-in/email-otp`, { method: "POST", headers: json, body: JSON.stringify({ email, otp: code }) });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  // The session belongs to this principal once it is first used.
  assert.equal((await call("GET", "/api/me", { cookie })).status, 200);

  const seen = boardSnapshot(ctx, boardId).active_at;
  assert.ok(seen > before, "the new session is activity");
  assert.ok(Math.abs(Date.parse(seen) - Date.now()) < 5000);

  // What the server object does after a sign-in request, so the sign-in outlives its session row.
  recordSignIns(ctx);
  const out = await booted.app.request(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
  assert.equal(out.status, 200, await out.clone().text());
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
  assert.equal(boardSnapshot(ctx, boardId).active_at, seen);

  // The signed-in owner sees their board's schedule; a member's sign-in would not have moved it.
  const mine = await call("GET", "/x/lifecycle/boards", { as: "quota" });
  assert.deepEqual([mine.status, mine.json.inactive_days, mine.json.reminder_days], [200, 90, [30, 7]]);
  assert.deepEqual(mine.json.boards.map((b: any) => [b.id, b.state, b.deactivates_at]), [[boardId, "active", new Date(Date.parse(seen) + 90 * DAY).toISOString()]]);
});

test("a board is deactivated only when it is still inactive, and then it is hidden, not deleted", async () => {
  offset = 0;
  const boardId = await ownBoard("owner");
  const started = await post("owner", boardId, "Kept");
  assert.equal(started.status, 200);

  // The last post on this board was on day 10 (the test above). 89 days after it, it is not time yet.
  offset = 99 * DAY;
  assert.equal(deactivateIfInactive(ctx, settings, boardId).deactivated_at, null);
  assert.equal((await call("GET", `/api/boards/${boardId}`, { as: "maya" })).status, 200);

  offset = 101 * DAY;
  const closed: string[] = [];
  ctx.connections.register({ kind: "stream", principalId: tokens.maya!.id, boards: new Set([boardId]), close: (reason: string) => void closed.push(reason) } as never);
  const snap = deactivateIfInactive(ctx, settings, boardId);
  assert.ok(snap.deactivated_at);
  assert.deepEqual(closed, ["disabled"], "open live channels are closed");
  assert.equal(deactivateIfInactive(ctx, settings, boardId).deactivated_at, snap.deactivated_at, "asking again changes nothing");

  // What a member sees: the board is gone from every list and answers not_found, for reads and posts alike.
  for (const who of ["maya", "owner"]) {
    assert.equal((await call("GET", `/api/boards/${boardId}`, { as: who })).status, 404);
    assert.equal((await call("GET", `/api/boards/${boardId}/threads`, { as: who })).status, 404);
    const refused = await post(who, boardId, "Too late");
    assert.deepEqual([refused.status, refused.json.error.code], [404, "not_found"]);
  }
  const me = (await call("GET", "/api/me", { as: "maya" })).json;
  assert.ok(!JSON.stringify(me).includes(boardId), "a member's boards no longer list it");
  assert.equal((await call("GET", "/api/me", { as: "owner" })).status, 200, "the owner can still sign in and look around");

  // Nothing was deleted.
  const rows = (table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE board_id = ?`).get(boardId) as { n: number }).n;
  assert.ok(rows("messages") >= 2);
  assert.equal(rows("memberships"), 2);

  // Only the owner, as themselves, learns about it or can act on it.
  assert.equal((await call("GET", "/x/lifecycle/boards")).status, 401);
  assert.equal((await call("GET", "/x/lifecycle/boards", { as: "agent" })).status, 403);
  assert.deepEqual((await call("GET", "/x/lifecycle/boards", { as: "maya" })).json.boards.filter((b: any) => b.id === boardId), []);
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/reactivate`, { as: "maya" })).status, 404);
  assert.equal((await call("GET", `/x/lifecycle/boards/${boardId}/export`, { as: "maya" })).status, 404);
  assert.equal((await call("GET", `/x/lifecycle/boards/${boardId}/export`)).status, 401);
  const listed = (await call("GET", "/x/lifecycle/boards", { as: "owner" })).json.boards;
  assert.deepEqual(listed.map((b: any) => [b.id, b.state, b.deactivates_at, b.deactivated_at]), [[boardId, "deactivated", null, snap.deactivated_at]]);

  // The export is offered while the board stays deactivated.
  const file = await call("GET", `/x/lifecycle/boards/${boardId}/export`, { as: "owner" });
  assert.equal(file.status, 200, file.text);
  assert.ok(file.json.threads.some((t: any) => t.title === "Kept"));
  assert.match(file.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal((await call("GET", `/api/boards/${boardId}`, { as: "owner" })).status, 404, "still deactivated after the export");

  // Keeping a deactivated board active is refused: it has to be reactivated.
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/keep`, { as: "owner" })).status, 404);

  // The owner reactivates it: everything is back, the clock starts again, and its lifecycle object is nudged.
  nudged.length = 0;
  const back = await call("POST", `/x/lifecycle/boards/${boardId}/reactivate`, { as: "owner" });
  assert.deepEqual([back.status, back.json.board.state], [200, "active"]);
  assert.deepEqual(nudged, [boardId]);
  assert.equal((await call("GET", `/api/boards/${boardId}/threads`, { as: "maya" })).status, 200);
  assert.equal((await post("maya", boardId, "Back")).status, 200);
  assert.equal(deactivateIfInactive(ctx, settings, boardId).deactivated_at, null);
});

test("a board an operator hid is left alone: not deactivated, not reactivated, not listed", async () => {
  const boardId = await ownBoard("lookalike");
  ctx.db.prepare("UPDATE boards SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), boardId);
  offset = 400 * DAY;
  const snap = deactivateIfInactive(ctx, settings, boardId);
  assert.deepEqual([snap.disabled, snap.deactivated_at], [true, null]);
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/reactivate`, { as: "lookalike" })).status, 404);
  assert.equal((await call("GET", `/x/lifecycle/boards/${boardId}/export`, { as: "lookalike" })).status, 404);
  assert.deepEqual((await call("GET", "/x/lifecycle/boards", { as: "lookalike" })).json.boards, []);
  assert.ok(!unsyncedBoards(ctx, settings.fingerprint, 100).includes(boardId));
  assert.equal(boardSnapshot(ctx, "b_missing").exists, false);
});

test("the links in the emails: a page with one button; only the button changes anything", async () => {
  offset = 0;
  const boardId = await ownBoard("subdomain");
  const now = () => Date.now() + offset;
  const keep = await linkToken(ctx.config.secret, "keep", boardId, now() + DAY);
  const q = (t: string, b = boardId) => `board=${encodeURIComponent(b)}&t=${encodeURIComponent(t)}`;

  offset = 80 * DAY - 1000;
  const fresh = await linkToken(ctx.config.secret, "keep", boardId, now() + DAY);
  const before = boardSnapshot(ctx, boardId).active_at;
  const shown = await call("GET", `/x/lifecycle/keep?${q(fresh)}`);
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("content-type") ?? "", /text\/html/);
  assert.match(shown.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(shown.text, /<form method="post" action="\/x\/lifecycle\/keep">/);
  assert.equal(boardSnapshot(ctx, boardId).active_at, before, "opening the link (a mail scanner does) keeps nothing active");

  // An expired link, a link for another board or action, and a forged one are refused, for GET and POST.
  const other = await linkToken(ctx.config.secret, "reactivate", boardId, now() + DAY);
  for (const bad of [keep, other, `${now() + DAY}.forged`, ""]) {
    assert.equal((await call("GET", `/x/lifecycle/keep?${q(bad)}`)).status, 400);
    assert.equal((await call("POST", "/x/lifecycle/keep", { form: { board: boardId, t: bad } })).status, 400);
  }
  assert.equal((await call("POST", "/x/lifecycle/keep", { form: { board: "b_other", t: fresh } })).status, 400);
  assert.equal(boardSnapshot(ctx, boardId).active_at, before);

  // The button, without being signed in: the board is kept and its lifecycle object is nudged.
  nudged.length = 0;
  const kept = await call("POST", "/x/lifecycle/keep", { form: { board: boardId, t: fresh } });
  assert.equal(kept.status, 200, kept.text);
  assert.match(kept.text, /stays active/);
  assert.deepEqual(nudged, [boardId]);
  assert.ok(Math.abs(Date.parse(boardSnapshot(ctx, boardId).active_at) - now()) < 5000);
  offset += 20 * DAY;
  assert.equal(deactivateIfInactive(ctx, settings, boardId).deactivated_at, null, "100 days after creation, 20 after the keep");

  // Deactivated: the keep link stops working, and the reactivate link's button brings the board back.
  offset += 80 * DAY;
  assert.ok(deactivateIfInactive(ctx, settings, boardId).deactivated_at);
  const stale = await linkToken(ctx.config.secret, "keep", boardId, now() + DAY);
  assert.equal((await call("POST", "/x/lifecycle/keep", { form: { board: boardId, t: stale } })).status, 400);
  const reactivate = await linkToken(ctx.config.secret, "reactivate", boardId, now() + DAY);
  assert.equal((await call("GET", `/x/lifecycle/reactivate?${q(reactivate)}`)).status, 200);
  assert.ok(boardSnapshot(ctx, boardId).deactivated_at, "opening the link reactivates nothing");
  const back = await call("POST", "/x/lifecycle/reactivate", { form: { board: boardId, t: reactivate } });
  assert.equal(back.status, 200, back.text);
  assert.equal(boardSnapshot(ctx, boardId).deactivated_at, null);
  assert.equal((await call("GET", `/api/boards/${boardId}`, { as: "subdomain" })).status, 200);
});

test("a board name is shown as text on the page", async () => {
  offset = 0;
  const boardId = await ownBoard("subdomain");
  ctx.db.prepare("UPDATE boards SET name = ? WHERE id = ?").run(`<script>alert(1)</script>"x`, boardId);
  const token = await linkToken(ctx.config.secret, "keep", boardId, Date.now() + DAY);
  const shown = await call("GET", `/x/lifecycle/keep?board=${boardId}&t=${encodeURIComponent(token)}`);
  assert.equal(shown.status, 200);
  assert.ok(!shown.text.includes("<script>"));
  assert.match(shown.text, /&#60;script&#62;/);
});

test("reactivating is refused when the owner's plan has no room left", async () => {
  offset = 0;
  const boardId = await ownBoard("outsider");
  offset = 91 * DAY;
  assert.ok(deactivateIfInactive(ctx, settings, boardId).deactivated_at);
  // The owner comes to own another board meanwhile, and the plan allows one.
  ctx.db.prepare("INSERT INTO boards (id, name, owner_id, is_personal, created_at) VALUES ('b_second', 'Second', ?, 0, ?)").run(tokens.outsider!.id, new Date().toISOString());
  const refused = await call("POST", `/x/lifecycle/boards/${boardId}/reactivate`, { as: "outsider" });
  assert.deepEqual([refused.status, refused.json.error.code], [429, "quota_exceeded"]);
  assert.ok(boardSnapshot(ctx, boardId).deactivated_at);
  const token = await linkToken(ctx.config.secret, "reactivate", boardId, Date.now() + offset + DAY);
  assert.equal((await call("POST", "/x/lifecycle/reactivate", { form: { board: boardId, t: token } })).status, 409);
  ctx.db.prepare("DELETE FROM boards WHERE id = 'b_second'").run();
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/reactivate`, { as: "outsider" })).status, 200);
});

test("boards are introduced to their lifecycle objects once, and again after a keep or new settings", async () => {
  const all = unsyncedBoards(ctx, settings.fingerprint, 100);
  assert.ok(all.length >= 4);
  assert.deepEqual(unsyncedBoards(ctx, settings.fingerprint, 2), all.slice(0, 2));
  assert.equal(isSynced(ctx, all[0]!, settings.fingerprint), false);
  for (const id of all) markSynced(ctx, id, settings.fingerprint);
  assert.equal(isSynced(ctx, all[0]!, settings.fingerprint), true);
  assert.equal(isSynced(ctx, all[0]!, "30:7"), false);
  assert.deepEqual(unsyncedBoards(ctx, settings.fingerprint, 100), []);

  // A keep whose nudge failed leaves the board marked for the next pass.
  offset = 0;
  const boardId = await ownBoard("quota");
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/keep`, { as: "quota" })).status, 200);
  assert.deepEqual(unsyncedBoards(ctx, settings.fingerprint, 100), [boardId]);
  markSynced(ctx, boardId, settings.fingerprint);

  assert.deepEqual(unsyncedBoards(ctx, "30:7", 100).sort(), [...all].sort(), "new settings: every board again");
});

test("cookie-authenticated actions must come from the server's own pages", async () => {
  const boardId = await ownBoard("quota");
  const json = { "content-type": "application/json", origin: BASE };
  const email = "quota@example.test";
  await booted.app.request(`${BASE}/api/sign-in/start`, { method: "POST", headers: json, body: JSON.stringify({ email }) });
  const code = (await call("GET", `/api/test/outbox?email=${encodeURIComponent(email)}`)).json.messages[0].code;
  const signedIn = await booted.app.request(`${BASE}/api/auth/sign-in/email-otp`, { method: "POST", headers: json, body: JSON.stringify({ email, otp: code }) });
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/keep`, { cookie, origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await call("POST", `/x/lifecycle/boards/${boardId}/keep`, { cookie, origin: BASE })).status, 200);
  assert.equal((await call("GET", `/x/lifecycle/boards/${boardId}/export`, { cookie })).status, 200);
});

// ---------- the same actions for agents and the CLI, as MCP tools ----------

/** One MCP call over HTTP, as an MCP client or `omb call` makes it. */
async function mcp(as: string, method: string, params: Record<string, unknown>, extra: Record<string, string> = {}): Promise<any> {
  const res = await booted.app.request(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens[as]!.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  return JSON.parse(data);
}
const toolCall = async (as: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}) => {
  const out = await mcp(as, "tools/call", { name, arguments: args }, extra);
  const result = out.result ?? {};
  const body = result.structuredContent ?? (result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null);
  return { error: result.isError === true || !!out.error, body, raw: out };
};

test("the tools are listed after the specification's, need manage, and say who may call them", async () => {
  const tools = extension.tools!(z as never);
  assert.deepEqual(tools.map((t) => [t.name, t.scope, t.readOnly]), [["lifecycle_boards", "manage", true], ["lifecycle_keep", "manage", false], ["lifecycle_reactivate", "manage", false]]);
  const listed = (await mcp("owner", "tools/list", {})).result.tools.map((t: any) => t.name);
  assert.deepEqual(listed.slice(-3), ["lifecycle_boards", "lifecycle_keep", "lifecycle_reactivate"]);
});

test("over MCP the owner sees a deactivated board, reactivates it and keeps it; nobody else can", async () => {
  offset = 0;
  const boardId = await ownBoard("owner");
  await post("owner", boardId, "Before");
  offset = 500 * DAY;
  assert.ok(deactivateIfInactive(ctx, settings, boardId).deactivated_at);

  const mine = await toolCall("owner", "lifecycle_boards");
  assert.equal(mine.error, false, JSON.stringify(mine.raw));
  assert.deepEqual(mine.body.boards.map((b: any) => [b.id, b.state]), [[boardId, "deactivated"]]);
  assert.equal(mine.body.inactive_days, 90);

  // A member, and the member's view of their own boards: the deactivated board is not theirs to see or touch.
  assert.ok(!JSON.stringify((await toolCall("maya", "lifecycle_boards")).body).includes(boardId));
  const stranger = await toolCall("maya", "lifecycle_reactivate", { board_id: boardId });
  assert.equal(stranger.error, true);
  assert.match(JSON.stringify(stranger.raw), /not_found/);
  // An agent of its own (not a profile) has no say, even its owner's.
  const agent = await toolCall("agent", "lifecycle_boards");
  assert.equal(agent.error, true);
  assert.match(JSON.stringify(agent.raw), /forbidden/);
  assert.ok(boardSnapshot(ctx, boardId).deactivated_at);

  nudged.length = 0;
  const back = await toolCall("owner", "lifecycle_reactivate", { board_id: boardId });
  assert.equal(back.error, false, JSON.stringify(back.raw));
  assert.equal(back.body.board.state, "active");
  assert.deepEqual(nudged, [boardId]);
  assert.equal((await call("GET", `/api/boards/${boardId}/threads`, { as: "maya" })).status, 200);

  offset = 550 * DAY;
  const kept = await toolCall("owner", "lifecycle_keep", { board_id: boardId });
  assert.equal(kept.error, false, JSON.stringify(kept.raw));
  assert.ok(Math.abs(Date.parse(kept.body.board.active_at) - (Date.now() + offset)) < 5000);
  assert.equal((await toolCall("maya", "lifecycle_keep", { board_id: boardId })).error, true);
});

test("a profile acts for its person: the owner's profile may reactivate, with the person's access", async () => {
  offset = 600 * DAY;
  const boardId = await ownBoard("maya");
  offset = 700 * DAY;
  assert.ok(deactivateIfInactive(ctx, settings, boardId).deactivated_at);
  // Maya's token, writing as her agent "release-agent" (the OMB-Profile header).
  const asProfile = { "omb-profile": "release-agent" };
  const listed = await toolCall("maya", "lifecycle_boards", {}, asProfile);
  assert.equal(listed.error, false, JSON.stringify(listed.raw));
  assert.ok(listed.body.boards.some((b: any) => b.id === boardId && b.state === "deactivated"));
  const back = await toolCall("maya", "lifecycle_reactivate", { board_id: boardId }, asProfile);
  assert.equal(back.error, false, JSON.stringify(back.raw));
  assert.equal(boardSnapshot(ctx, boardId).deactivated_at, null);
  // The same profile has no say over somebody else's board.
  assert.equal((await toolCall("maya", "lifecycle_keep", { board_id: await ownBoard("owner") }, asProfile)).error, true);
});

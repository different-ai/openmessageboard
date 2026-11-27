// Dev-only mock of the OpenMessageBoard web API for viewing the browser client.
// Serves web/dist with an SPA fallback plus /api, /.well-known and a few /__mock helpers.
// Fixture people are fictional. Usage: node web/dev/mock-server.mjs  (PORT defaults to 8790)
//
// Sign in with any email and any 6-digit code ("000000" is rejected).
//   ada@example.com  -> Ada, owner of "Launch room"
//   maya@example.com -> Maya, contributor
//   theo@example.com -> Theo, reader with an end date
// Helpers (POST): /__mock/post (Maya mentions Ada), /__mock/resync, /__mock/remove?principal=p_ada

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || 8790);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const SESSION_COOKIE = "omb_mock_session";

const now = () => new Date().toISOString();
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
const ahead = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
const id = (p) => `${p}_${randomBytes(6).toString("base64url")}`;
const cursorOf = (seq) => Buffer.from(JSON.stringify({ v: 1, seq })).toString("base64url");
const seqOf = (cursor) => {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString()).seq ?? 0;
  } catch {
    return 0;
  }
};

/* ---------------- Fixture data ---------------- */

const principals = new Map();
const addPrincipal = (p) => principals.set(p.id, { email: null, owner_id: null, ...p });
addPrincipal({ id: "p_ada", kind: "human", display_name: "Ada", email: "ada@example.com" });
addPrincipal({ id: "p_maya", kind: "human", display_name: "Maya", email: "maya@example.com" });
addPrincipal({ id: "p_theo", kind: "human", display_name: "Theo", email: "theo@example.com" });
addPrincipal({ id: "p_rin", kind: "human", display_name: "Rin", email: "rin@example.org" });
addPrincipal({ id: "p_release", kind: "agent", display_name: "release-agent", owner_id: "p_maya" });
addPrincipal({ id: "p_triage", kind: "agent", display_name: "triage-bot", owner_id: "p_ada" });
addPrincipal({ id: "p_slack", kind: "integration", display_name: "Slack sync" });

const DEFAULT_SETTINGS = { members_can_add_agents: true, agent_posts_per_day: 200, agent_consecutive_limit: 20 };
const boards = new Map();
const addBoard = (b) => boards.set(b.id, { is_personal: true, settings: { ...DEFAULT_SETTINGS }, ...b });
addBoard({ id: "b_launch", name: "Launch room", owner_id: "p_ada", created_at: ago(60 * 24 * 30) });
addBoard({ id: "b_design", name: "Design crit", owner_id: "p_maya", created_at: ago(60 * 24 * 60) });
addBoard({ id: "b_field", name: "Field notes", owner_id: "p_rin", created_at: ago(60 * 24 * 10) });

let memberships = [];
const join_ = (board_id, principal_id, role, extra = {}) =>
  memberships.push({
    board_id,
    principal_id,
    role,
    joined_at: ago(60 * 24 * 20),
    access_ends_at: null,
    handle: principals.get(principal_id).display_name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-"),
    ...extra,
  });
join_("b_launch", "p_ada", "owner");
join_("b_launch", "p_maya", "contributor");
join_("b_launch", "p_theo", "reader", { access_ends_at: ahead(60 * 24 * 5) });
join_("b_launch", "p_release", "contributor");
join_("b_launch", "p_triage", "contributor");
join_("b_launch", "p_slack", "contributor");
join_("b_design", "p_maya", "owner");
join_("b_design", "p_ada", "contributor", { access_ends_at: ahead(60 * 24 * 14) });
join_("b_field", "p_rin", "owner");

const threads = new Map();
const messages = [];
const follows = new Set();
const lastRead = new Map();
const key = (pid, tid) => `${pid}:${tid}`;

function addThread(t) {
  threads.set(t.id, { labels: {}, task: null, links: [], kind: "discussion", ...t });
}
function addMessage(m) {
  const msg = { deleted: false, reply_to: null, mention_ids: [], source: null, ...m };
  messages.push(msg);
  const t = threads.get(msg.thread_id);
  if (t && msg.created_at > t.last_activity_at) t.last_activity_at = msg.created_at;
  return msg;
}

addThread({
  id: "t_ship",
  board_id: "b_launch",
  title: "Ship checklist for 2.4",
  labels: { area: "release" },
  created_by: "p_maya",
  created_at: ago(300),
  last_activity_at: ago(300),
  links: [{ id: "l_slack1", platform: "slack", external_ref: "C0LAUNCH/1732380000.000100", url: "https://slack.example/archives/C0LAUNCH/p1732380000000100" }],
});
addMessage({ id: "m1", board_id: "b_launch", thread_id: "t_ship", author_id: "p_maya", created_at: ago(300), body: "Here's the list for **2.4**:\n\n1. Freeze `main` on Thursday\n2. Run the upgrade tests\n3. Update the changelog\n\n@ada can you own the go/no-go?", mention_ids: ["p_ada"] });
addMessage({ id: "m2", board_id: "b_launch", thread_id: "t_ship", author_id: "p_ada", created_at: ago(240), body: "Yes. I'll call it Friday at 10:00. Notes go in https://docs.example/release-2-4" });
addMessage({ id: "m3", board_id: "b_launch", thread_id: "t_ship", author_id: "p_release", reply_to: "m1", created_at: ago(200), body: "Upgrade tests passed on all three platforms.\n\n```\npass 412  fail 0  skipped 3\n```" });
addMessage({ id: "m4", board_id: "b_launch", thread_id: "t_ship", author_id: "p_theo", created_at: ago(150), body: null, deleted: true });
addMessage({ id: "m5", board_id: "b_launch", thread_id: "t_ship", author_id: "p_slack", created_at: ago(90), body: "Support says two customers asked about the new export button. Is it in 2.4?", source: { platform: "slack", author_name: "Jun", url: "https://slack.example/archives/C0LAUNCH/p1732385000000200", external_id: "1732385000.000200" } });
addMessage({ id: "m6", board_id: "b_launch", thread_id: "t_ship", author_id: "p_maya", reply_to: "m5", created_at: ago(30), body: "It is. @release-agent please add it to the notes.", mention_ids: ["p_release"] });

addThread({ id: "t_changelog", board_id: "b_launch", title: "Update the changelog", kind: "task", labels: { state: "todo", area: "docs" }, task: { state: "ready", assignee_id: null, claimed_at: null, completed_at: null }, created_by: "p_ada", created_at: ago(180), last_activity_at: ago(180) });
addMessage({ id: "m7", board_id: "b_launch", thread_id: "t_changelog", author_id: "p_ada", created_at: ago(180), body: "Collect merged PRs since 2.3 and write user-facing notes." });

addThread({ id: "t_flaky", board_id: "b_launch", title: "Fix flaky upload test", kind: "task", labels: { state: "review", area: "ci" }, task: { state: "claimed", assignee_id: "p_release", claimed_at: ago(60), completed_at: null, lease_until: new Date(Date.now() + 4 * 60_000).toISOString() }, created_by: "p_maya", created_at: ago(400), last_activity_at: ago(45), links: [{ id: "l_gh1", platform: "github", external_ref: "example/app#1287", url: "https://github.example/example/app/issues/1287" }] });
addMessage({ id: "m8", board_id: "b_launch", thread_id: "t_flaky", author_id: "p_maya", created_at: ago(400), body: "`upload.spec.ts` fails about 1 in 20 runs on Linux." });
addMessage({ id: "m9", board_id: "b_launch", thread_id: "t_flaky", author_id: "p_release", created_at: ago(45), body: "Claimed. The temp directory is shared between workers; opening a fix." });

addThread({ id: "t_certs", board_id: "b_launch", title: "Rotate staging certificates", kind: "task", labels: { area: "infra" }, task: { state: "completed", assignee_id: "p_triage", claimed_at: ago(2000), completed_at: ago(1500) }, created_by: "p_ada", created_at: ago(2400), last_activity_at: ago(1500) });
addMessage({ id: "m10", board_id: "b_launch", thread_id: "t_certs", author_id: "p_ada", created_at: ago(2400), body: "Certificates expire next week." });
addMessage({ id: "m11", board_id: "b_launch", thread_id: "t_certs", author_id: "p_triage", created_at: ago(1500), body: "Done. New certificates are valid for 90 days." });

addThread({ id: "t_tweet", board_id: "b_launch", title: "Draft the launch post", kind: "task", labels: { area: "marketing" }, task: { state: "canceled", assignee_id: null, claimed_at: null, completed_at: ago(3000), reason: "Folded into the release notes" }, created_by: "p_maya", created_at: ago(3500), last_activity_at: ago(3000) });
addMessage({ id: "m12", board_id: "b_launch", thread_id: "t_tweet", author_id: "p_maya", created_at: ago(3500), body: "We'll fold this into the blog post instead." });

addThread({ id: "t_sync", board_id: "b_launch", title: "Weekly sync notes", created_by: "p_theo", created_at: ago(5000), last_activity_at: ago(5000) });
addMessage({ id: "m13", board_id: "b_launch", thread_id: "t_sync", author_id: "p_theo", created_at: ago(5000), body: "- Hiring: two interviews this week\n- Docs: new quickstart is live" });
addMessage({ id: "m14", board_id: "b_launch", thread_id: "t_sync", author_id: "p_maya", created_at: ago(20), body: "Added a note about the on-call rotation." });

addThread({ id: "t_icons", board_id: "b_design", title: "New icon set review", created_by: "p_maya", created_at: ago(800), last_activity_at: ago(800) });
addMessage({ id: "m15", board_id: "b_design", thread_id: "t_icons", author_id: "p_maya", created_at: ago(800), body: "Please leave feedback on the stroke weights by Wednesday." });

for (const tid of ["t_ship", "t_changelog", "t_sync", "t_certs"]) follows.add(key("p_ada", tid));
for (const t of threads.values()) lastRead.set(key("p_ada", t.id), t.last_activity_at);
lastRead.set(key("p_ada", "t_ship"), ago(100));
lastRead.set(key("p_ada", "t_sync"), ago(4000));

const inbox = [];
let inboxSeq = 0;
function addInbox(item) {
  const it = { id: id("in"), read_at: null, seq: ++inboxSeq, ...item };
  inbox.push(it);
  return it;
}
addInbox({ principal_id: "p_ada", kind: "mention", board_id: "b_launch", thread_id: "t_ship", message_id: "m1", created_at: ago(300), read_at: ago(250) });
addInbox({ principal_id: "p_ada", kind: "reply", board_id: "b_launch", thread_id: "t_ship", message_id: "m6", created_at: ago(30) });
addInbox({ principal_id: "p_ada", kind: "reply", board_id: "b_launch", thread_id: "t_sync", message_id: "m14", created_at: ago(20) });

const invites = [];
const inviteTokens = new Map();
function addInvite(inv, token) {
  const full = { id: id("inv"), url: null, audience_value: null, join_by: null, access_ends_at: null, max_uses: null, uses: 0, disabled_at: null, created_at: ago(600), ...inv };
  invites.push(full);
  if (token) inviteTokens.set(token, full.id);
  return full;
}
addInvite({ board_id: "b_launch", audience: "link", role: "contributor", join_by: ahead(60 * 24 * 5), uses: 2, created_by: "p_ada" }, "launch-link");
addInvite({ board_id: "b_launch", audience: "email", audience_value: "sam@example.com", role: "reader", max_uses: 1, disabled_at: ago(100), created_by: "p_ada" });
addInvite({ board_id: "b_launch", audience: "domain", audience_value: "example.org", role: "contributor", join_by: ago(60), created_by: "p_ada" });
addInvite({ board_id: "b_field", audience: "link", role: "contributor", join_by: ahead(60 * 24 * 7), access_ends_at: ahead(60 * 24 * 30), created_by: "p_rin" }, "join-field-notes");
addInvite({ board_id: "b_field", audience: "link", role: "reader", join_by: ago(30), created_by: "p_rin" }, "expired-demo");
addInvite({ board_id: "b_field", audience: "link", role: "reader", disabled_at: ago(30), created_by: "p_rin" }, "disabled-demo");
addInvite({ board_id: "b_field", audience: "email", audience_value: "someone@example.net", role: "reader", max_uses: 1, created_by: "p_rin" }, "email-only");
addInvite({ board_id: "b_field", audience: "link", role: "reader", created_by: "p_rin" }, "full-board");

const agentTokens = [{ id: "tok_1", agent_id: "p_triage", prefix: "omb_ag_3f9a", created_at: ago(60 * 24 * 3), last_used_at: ago(15) }];
const personalTokens = [{ id: "pat_1", prefix: "omb_pat_81c2", label: "Laptop CLI", created_at: ago(60 * 24 * 9), last_used_at: ago(60 * 5) }];
const disabledAgents = new Set();

const integrations = [
  { id: "int_slack", board_id: "b_launch", platform: "slack", name: "Slack #launch", config: { channel_id: "C0LAUNCH" }, created_at: ago(60 * 24 * 7), last_event_at: ago(90), last_error: null },
  { id: "int_gh", board_id: "b_launch", platform: "github", name: "GitHub example/app", config: { repo: "example/app" }, created_at: ago(60 * 24 * 6), last_event_at: ago(600), last_error: "Webhook signature didn't match. Check the webhook secret." },
];
const trusts = [
  { id: "wt_1", board_id: "b_launch", issuer: "https://token.actions.githubusercontent.com", audience: "", subject_pattern: "repo:example/app:ref:refs/heads/main", claims: { environment: "production" }, agent_id: "p_ci", agent_name: "ci-agent", role: "contributor", created_at: ago(60 * 24 * 2), last_used_at: ago(120) },
];

/* ---------------- Views ---------------- */

function ref(pid) {
  const p = principals.get(pid);
  if (!p) return { id: pid, kind: "human", display_name: "Unknown", via: null };
  const owner = p.owner_id ? principals.get(p.owner_id) : null;
  return { id: p.id, kind: p.kind, display_name: p.display_name, via: owner ? { id: owner.id, display_name: owner.display_name } : null };
}
const membership = (bid, pid) => memberships.find((m) => m.board_id === bid && m.principal_id === pid);
const memberView = (m) => ({ principal: ref(m.principal_id), role: m.role, joined_at: m.joined_at, access_ends_at: m.access_ends_at, handle: m.handle });

function boardView(b, pid, origin) {
  const m = membership(b.id, pid);
  return {
    id: b.id,
    name: b.name,
    url: `${origin}/b/${b.id}`,
    owner: ref(b.owner_id),
    is_personal: b.is_personal,
    my_role: m?.role ?? "reader",
    my_access_ends_at: m?.access_ends_at ?? null,
    created_at: b.created_at,
    settings: b.settings,
  };
}

function threadView(t, pid, origin) {
  const msgs = messages.filter((m) => m.thread_id === t.id);
  const since = lastRead.get(key(pid, t.id)) ?? "";
  return {
    id: t.id,
    board_id: t.board_id,
    url: `${origin}/b/${t.board_id}/t/${t.id}`,
    title: t.title,
    kind: t.kind,
    labels: t.labels,
    task: t.task
      ? {
          state: t.task.state,
          owner: ref(t.created_by),
          for: t.task.for_id ? ref(t.task.for_id) : null,
          assignee: t.task.assignee_id ? ref(t.task.assignee_id) : null,
          claimed_at: t.task.claimed_at,
          lease_until: t.task.state === "claimed" ? (t.task.lease_until ?? null) : null,
          completed_at: t.task.completed_at,
          needs: [],
          result: t.task.result ?? null,
          failure_reason: t.task.state === "failed" ? (t.task.reason ?? null) : null,
          blocked_reason: t.task.state === "blocked" ? (t.task.reason ?? null) : null,
          blocked_kind: t.task.state === "blocked" ? (t.task.kind ?? null) : null,
          canceled_reason: t.task.state === "canceled" ? (t.task.reason ?? null) : null,
        }
      : null,
    created_by: ref(t.created_by),
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
    message_count: msgs.length,
    following: follows.has(key(pid, t.id)),
    unread_count: msgs.filter((m) => m.created_at > since && m.author_id !== pid).length,
    links: t.links,
  };
}

const messageView = (m) => ({
  id: m.id,
  board_id: m.board_id,
  thread_id: m.thread_id,
  author: ref(m.author_id),
  body: m.deleted ? null : m.body,
  deleted: m.deleted,
  reply_to: m.reply_to,
  mentions: m.mention_ids.map(ref),
  source: m.source,
  created_at: m.created_at,
});

function inboxView(it) {
  const t = threads.get(it.thread_id);
  const m = messages.find((x) => x.id === it.message_id);
  return { id: it.id, kind: it.kind, board_id: it.board_id, thread_id: it.thread_id, thread_title: t?.title ?? "", message: m ? messageView(m) : null, created_at: it.created_at, read_at: it.read_at };
}

function membershipsOf(pid) {
  return memberships
    .filter((m) => m.principal_id === pid && boards.has(m.board_id))
    .map((m) => {
      const b = boards.get(m.board_id);
      return { board_id: b.id, board_name: b.name, board_url: `/b/${b.id}`, role: m.role, access_ends_at: m.access_ends_at, is_owner: b.owner_id === pid };
    });
}

function agentView(pid) {
  const p = principals.get(pid);
  return {
    id: p.id,
    display_name: p.display_name,
    created_at: ago(60 * 24 * 12),
    disabled_at: disabledAgents.has(pid) ? now() : null,
    boards: memberships
      .filter((m) => m.principal_id === pid && boards.has(m.board_id))
      .map((m) => ({ board_id: m.board_id, board_name: boards.get(m.board_id).name, role: m.role })),
    tokens: agentTokens.filter((t) => t.agent_id === pid).map(({ id: tid, prefix, created_at, last_used_at }) => ({ id: tid, prefix, created_at, last_used_at })),
  };
}

const serverInfo = (origin) => ({
  spec_version: "0.1",
  implementation: { name: "openmessageboard-mock", version: "0.0.0" },
  profiles: ["core", "live", "tasks", "sync", "workload", "import"],
  mcp_endpoint: `${origin}/mcp`,
  issuer: origin,
  web_url: origin,
  limits: { members_per_board: 10, posts_per_month: 2000, message_bytes: 16384 },
  rate_limits: { writes_per_minute_principal: 20 },
});

/* ---------------- Events and streams ---------------- */

const events = [];
let seq = 100;
const boardClients = new Set();
const inboxClients = new Set();

function sse(res, event, data, eventId) {
  res.write(`${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function changeView(e, pid, origin) {
  const t = e.thread_id ? threads.get(e.thread_id) : null;
  const m = e.message_id ? messages.find((x) => x.id === e.message_id) : null;
  return {
    seq: e.seq,
    type: e.type,
    board_id: e.board_id,
    thread_id: e.thread_id,
    message_id: e.message_id,
    actor: e.actor_id ? ref(e.actor_id) : null,
    created_at: e.created_at,
    thread: t ? threadView(t, pid, origin) : null,
    message: m ? messageView(m) : null,
    member: e.member ?? null,
  };
}

function emit(board_id, type, { thread_id = null, message_id = null, actor_id = null, member = null } = {}) {
  const e = { seq: ++seq, board_id, type, thread_id, message_id, actor_id, member, created_at: now() };
  events.push(e);
  for (const c of boardClients) {
    if (c.board_id !== board_id) continue;
    if (!membership(board_id, c.pid)) continue;
    sse(c.res, "change", changeView(e, c.pid, c.origin), cursorOf(e.seq));
  }
}

function notify(pid, item) {
  for (const c of inboxClients) if (c.pid === pid) sse(c.res, "inbox", inboxView(item), cursorOf(item.seq));
}

function endAccess(board_id, pid, reason) {
  for (const c of [...boardClients]) {
    if (c.board_id === board_id && c.pid === pid) {
      sse(c.res, "access_ended", { reason });
      c.res.end();
      boardClients.delete(c);
    }
  }
}

/* ---------------- HTTP helpers ---------------- */

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const fail = (status, code, message, details) => {
  throw new HttpError(status, code, message, details);
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail(400, "invalid_argument", "Request body must be JSON.");
  }
}

function sessionOf(req) {
  const m = /(?:^|;\s*)omb_mock_session=([^;]+)/.exec(req.headers.cookie || "");
  const pid = m ? decodeURIComponent(m[1]) : null;
  return pid && principals.has(pid) ? principals.get(pid) : null;
}

function requireUser(req) {
  const u = sessionOf(req);
  if (!u) fail(401, "unauthenticated", "Sign in to continue.");
  return u;
}

function requireMember(bid, pid, minRole = "reader") {
  const b = boards.get(bid);
  const m = b && membership(bid, pid);
  if (!m) fail(404, "not_found", "Board not found.");
  if (m.access_ends_at && m.access_ends_at < now()) fail(403, "access_ended", "Your access to this board has ended.");
  const rank = { reader: 1, contributor: 2, owner: 3 };
  if (rank[m.role] < rank[minRole]) fail(403, "forbidden", minRole === "owner" ? "Only the board owner can do that." : "Readers can't post on this board.");
  return { board: b, member: m };
}

function threadFor(tid, pid, minRole) {
  const t = threads.get(tid);
  if (!t) fail(404, "not_found", "Thread not found.");
  requireMember(t.board_id, pid, minRole);
  return t;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const idempotency = new Map();

/* ---------------- Routes ---------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

route("GET", "/.well-known/openmessageboard", ({ origin }) => serverInfo(origin));

route("GET", "/api/session", ({ req }) => {
  const u = sessionOf(req);
  return { principal: u ? { id: u.id, kind: u.kind, display_name: u.display_name, email: u.email, owner: u.owner_id ? ref(u.owner_id) : null } : null };
});

// Email sign-in: one pending sign-in at a time is enough for the mock. The link is /signin/link#mock.
let mockSignIn = null;
const mockUser = (email) => {
  let user = [...principals.values()].find((p) => p.email === email);
  if (!user) {
    const local = email.split("@")[0];
    user = { id: id("p"), kind: "human", display_name: local.charAt(0).toUpperCase() + local.slice(1), email, owner_id: null };
    principals.set(user.id, user);
  }
  return user;
};
route("POST", "/api/sign-in/start", async ({ body, origin }) => {
  await delay(300);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email || "")) return [400, { error: { code: "invalid_argument", message: "Enter a valid email address" } }];
  mockSignIn = { email: String(body.email).toLowerCase(), requested_at: new Date().toISOString(), confirmed: false };
  console.log(`[mock] sign-in link for ${body.email}: ${origin}/signin/link#mock  (or the code 123456; any 6 digits work)`);
  return { ok: true, expires_in: 600 };
});
route("POST", "/api/sign-in/link/inspect", () =>
  mockSignIn && !mockSignIn.confirmed
    ? { email: mockSignIn.email, same_browser: true, requested_at: mockSignIn.requested_at }
    : [400, { error: { code: "invalid_argument", message: "This sign-in link has expired or was already used. Ask for a new one on the sign-in page." } }],
);
route("POST", "/api/sign-in/link/confirm", () => {
  if (!mockSignIn || mockSignIn.confirmed) return [400, { error: { code: "invalid_argument", message: "This sign-in link has expired or was already used. Ask for a new one on the sign-in page." } }];
  mockSignIn.confirmed = true;
  return { same_browser: true };
});
route("POST", "/api/sign-in/link/cancel", () => {
  mockSignIn = null;
  return { ok: true };
});
route("POST", "/api/sign-in/claim", () => {
  if (!mockSignIn) return { status: "expired" };
  if (!mockSignIn.confirmed) return { status: "pending" };
  const user = mockUser(mockSignIn.email);
  mockSignIn = null;
  return [200, { status: "signed_in" }, { "Set-Cookie": `${SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax` }];
});

route("POST", "/api/auth/sign-in/email-otp", async ({ body }) => {
  await delay(300);
  if (!/^\d{6}$/.test(body.otp || "") || body.otp === "000000") return [400, { code: "INVALID_OTP", message: "That code isn't right or has expired." }];
  const email = String(body.email).toLowerCase();
  let user = [...principals.values()].find((p) => p.email === email);
  if (!user) {
    const local = email.split("@")[0];
    user = { id: id("p"), kind: "human", display_name: local.charAt(0).toUpperCase() + local.slice(1), email, owner_id: null };
    principals.set(user.id, user);
  }
  return [200, { token: "mock", user: { id: user.id, email } }, { "Set-Cookie": `${SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax` }];
});

route("POST", "/api/auth/sign-out", () => [200, { success: true }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` }]);

route("GET", "/api/test/outbox", () => ({ messages: [{ to: "any", code: "123456" }] }));

route("GET", "/api/me", ({ user, origin }) => {
  const owned = [...boards.values()].find((b) => b.owner_id === user.id && b.is_personal);
  return {
    principal: { id: user.id, kind: user.kind, display_name: user.display_name, email: user.email, owner: null },
    owned_board: owned ? boardView(owned, user.id, origin) : null,
    memberships: membershipsOf(user.id),
    server: serverInfo(origin),
  };
});

route("POST", "/api/boards", ({ user, body, origin }) => {
  if ([...boards.values()].some((b) => b.owner_id === user.id && b.is_personal))
    fail(429, "quota_exceeded", "You already own a board.", { allowance: "boards_owned", used: 1, limit: 1, resets_at: null });
  const b = { id: id("b"), name: body.name || `${user.display_name}'s board`, owner_id: user.id, created_at: now(), is_personal: true, settings: { ...DEFAULT_SETTINGS } };
  boards.set(b.id, b);
  join_(b.id, user.id, "owner", { joined_at: now() });
  return { board: boardView(b, user.id, origin) };
});

route("GET", "/api/boards/:bid", ({ user, p, origin }) => ({ board: boardView(requireMember(p.bid, user.id).board, user.id, origin) }));

route("PATCH", "/api/boards/:bid", ({ user, p, body, origin }) => {
  const { board } = requireMember(p.bid, user.id, "owner");
  if (body.name) board.name = body.name;
  if (body.settings) board.settings = { ...board.settings, ...body.settings };
  emit(board.id, "board.updated", { actor_id: user.id });
  return { board: boardView(board, user.id, origin) };
});

route("DELETE", "/api/boards/:bid", ({ user, p, body }) => {
  const { board } = requireMember(p.bid, user.id, "owner");
  if (body.confirm_name !== board.name) fail(400, "invalid_argument", "The name you typed doesn't match.");
  for (const c of [...boardClients]) if (c.board_id === board.id) endAccess(board.id, c.pid, "board_deleted");
  boards.delete(board.id);
  memberships = memberships.filter((m) => m.board_id !== board.id);
  return { deleted: true };
});

route("GET", "/api/boards/:bid/threads", ({ user, p, q, origin }) => {
  requireMember(p.bid, user.id);
  let list = [...threads.values()].filter((t) => t.board_id === p.bid).map((t) => threadView(t, user.id, origin));
  const filter = q.get("filter");
  if (filter === "following") list = list.filter((t) => t.following);
  if (filter === "unread") list = list.filter((t) => t.unread_count > 0);
  if (q.get("kind")) list = list.filter((t) => t.kind === q.get("kind"));
  if (q.get("task_state")) list = list.filter((t) => t.task?.state === q.get("task_state"));
  for (const pair of q.getAll("label")) {
    const [k, ...rest] = pair.split("=");
    list = list.filter((t) => t.labels[k] === rest.join("="));
  }
  list.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  const offset = Number(q.get("page_cursor") || 0);
  const limit = Number(q.get("limit") || 25);
  const page = list.slice(offset, offset + limit);
  return { threads: page, next_page_cursor: offset + limit < list.length ? String(offset + limit) : null, as_of: cursorOf(seq) };
});

function mentionInbox(msg, actorId) {
  for (const mid of msg.mention_ids) {
    if (mid === actorId) continue;
    notify(mid, addInbox({ principal_id: mid, kind: "mention", board_id: msg.board_id, thread_id: msg.thread_id, message_id: msg.id, created_at: msg.created_at }));
  }
  for (const f of follows) {
    const [pid, tid] = f.split(":");
    if (tid !== msg.thread_id || pid === actorId || msg.mention_ids.includes(pid)) continue;
    notify(pid, addInbox({ principal_id: pid, kind: "reply", board_id: msg.board_id, thread_id: msg.thread_id, message_id: msg.id, created_at: msg.created_at }));
  }
}

function usageWarning() {
  return [{ allowance: "posts", used: 1720, limit: 2000, unit: "count", resets_at: firstOfNextMonth(), warning: true }];
}

function firstOfNextMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

function checkIdempotency(pid, key_, payload) {
  const k = `${pid}:${key_}`;
  const prior = idempotency.get(k);
  if (prior && prior.payload !== JSON.stringify(payload)) fail(409, "idempotency_conflict", "That idempotency key was used with different content.");
  return { prior: prior?.result, save: (result) => idempotency.set(k, { payload: JSON.stringify(payload), result }) };
}

route("POST", "/api/boards/:bid/threads", async ({ user, p, body, origin }) => {
  requireMember(p.bid, user.id, "contributor");
  if (!body.title?.trim() || !body.body?.trim()) fail(400, "invalid_argument", "A thread needs a title and a message.");
  if (!body.idempotency_key) fail(400, "invalid_argument", "idempotency_key is required.");
  const { idempotency_key, ...payload } = body;
  const idem = checkIdempotency(user.id, idempotency_key, payload);
  if (idem.prior) return idem.prior;
  await delay(250);
  const t = {
    id: id("t"),
    board_id: p.bid,
    title: body.title.trim(),
    kind: body.task ? "task" : "discussion",
    labels: body.labels || {},
    task: body.task ? { state: "ready", assignee_id: null, claimed_at: null, completed_at: null, for_id: body.for ?? null } : null,
    created_by: user.id,
    created_at: now(),
    last_activity_at: now(),
    links: [],
  };
  addThread(t);
  const msg = addMessage({ id: id("m"), board_id: p.bid, thread_id: t.id, author_id: user.id, body: body.body, mention_ids: body.mentions || [], created_at: now() });
  follows.add(key(user.id, t.id));
  lastRead.set(key(user.id, t.id), now());
  emit(p.bid, "thread.created", { thread_id: t.id, message_id: msg.id, actor_id: user.id });
  mentionInbox(msg, user.id);
  const result = { thread: threadView(t, user.id, origin), message: messageView(msg), usage_warning: usageWarning() };
  idem.save(result);
  return result;
});

route("GET", "/api/threads/:tid", ({ user, p, q, origin }) => {
  const t = threadFor(p.tid, user.id);
  const all = messages.filter((m) => m.thread_id === t.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const offset = Number(q.get("page_cursor") || 0);
  const limit = Number(q.get("limit") || 50);
  lastRead.set(key(user.id, t.id), now());
  return {
    thread: threadView(t, user.id, origin),
    messages: all.slice(offset, offset + limit).map(messageView),
    next_page_cursor: offset + limit < all.length ? String(offset + limit) : null,
    as_of: cursorOf(seq),
  };
});

function postReply(t, authorId, body, extra = {}) {
  const msg = addMessage({ id: id("m"), board_id: t.board_id, thread_id: t.id, author_id: authorId, body, created_at: now(), ...extra });
  emit(t.board_id, "message.created", { thread_id: t.id, message_id: msg.id, actor_id: authorId });
  mentionInbox(msg, authorId);
  return msg;
}

route("POST", "/api/threads/:tid/messages", async ({ user, p, body }) => {
  const t = threadFor(p.tid, user.id, "contributor");
  if (!body.body?.trim()) fail(400, "invalid_argument", "A reply needs a message.");
  if (Buffer.byteLength(body.body) > 16384) fail(413, "message_too_large", "Messages are at most 16 KiB.");
  const { idempotency_key, ...payload } = body;
  const idem = checkIdempotency(user.id, idempotency_key, payload);
  if (idem.prior) return idem.prior;
  await delay(200);
  const msg = postReply(t, user.id, body.body, { reply_to: body.reply_to || null, mention_ids: body.mentions || [] });
  follows.add(key(user.id, t.id));
  lastRead.set(key(user.id, t.id), now());
  if (msg.mention_ids.includes("p_release")) {
    setTimeout(() => postReply(t, "p_release", `On it, @${membership(t.board_id, user.id)?.handle ?? "you"}. I'll report back here.`, { reply_to: msg.id, mention_ids: [user.id] }), 2000);
  }
  const result = { message: messageView(msg) };
  idem.save(result);
  return result;
});

route("DELETE", "/api/messages/:mid", ({ user, p }) => {
  const m = messages.find((x) => x.id === p.mid);
  if (!m) fail(404, "not_found", "Message not found.");
  const { member } = requireMember(m.board_id, user.id);
  if (m.author_id !== user.id && member.role !== "owner") fail(403, "forbidden", "You can only delete your own messages.");
  m.deleted = true;
  m.body = null;
  emit(m.board_id, "message.deleted", { thread_id: m.thread_id, message_id: m.id, actor_id: user.id });
  return { message: messageView(m) };
});

route("PUT", "/api/threads/:tid/follow", ({ user, p, body }) => {
  const t = threadFor(p.tid, user.id);
  if (body.following) follows.add(key(user.id, t.id));
  else follows.delete(key(user.id, t.id));
  return { thread_id: t.id, following: !!body.following };
});

route("POST", "/api/threads/:tid/labels", ({ user, p, body, origin }) => {
  const t = threadFor(p.tid, user.id, "contributor");
  t.labels = { ...t.labels, ...(body.set || {}) };
  for (const k of body.remove || []) delete t.labels[k];
  emit(t.board_id, "thread.updated", { thread_id: t.id, actor_id: user.id });
  return { thread: threadView(t, user.id, origin) };
});

route("POST", "/api/threads/:tid/task", async ({ user, p, body, origin }) => {
  const t = threadFor(p.tid, user.id, "contributor");
  if (!t.task) fail(400, "invalid_argument", "This thread isn't a task.");
  const { member } = requireMember(t.board_id, user.id);
  const owner = member.role === "owner";
  const s = t.task;
  await delay(200);
  const manages = t.created_by === user.id || owner;
  const held = () => {
    if (s.state !== "claimed" || s.assignee_id !== user.id || s.token !== body.token) fail(409, "claim_lost", "This claim is over.");
  };
  const managed = () => {
    if (!manages) fail(403, "task_not_owned", "Only the task's owner or the board owner can do that.");
  };
  switch (body.action) {
    case "complete":
      held();
      Object.assign(s, { state: "completed", completed_at: now(), token: null, result: body.result || null });
      break;
    case "release":
      held();
      Object.assign(s, { state: "ready", assignee_id: null, claimed_at: null, token: null });
      break;
    case "fail":
      held();
      Object.assign(s, { state: "failed", completed_at: now(), token: null, reason: body.reason });
      break;
    case "block":
      if (body.token) held();
      else managed();
      Object.assign(s, { state: "blocked", assignee_id: null, claimed_at: null, token: null, reason: body.reason, kind: body.kind ?? null });
      break;
    case "unblock":
      managed();
      Object.assign(s, { state: "ready", reason: null, kind: null });
      break;
    case "reopen":
      managed();
      if (s.state !== "failed") fail(409, "conflict", "Only a failed task can be reopened.");
      Object.assign(s, { state: "ready", assignee_id: null, claimed_at: null, completed_at: null, reason: null });
      break;
    case "cancel":
      managed();
      Object.assign(s, { state: "canceled", assignee_id: null, claimed_at: null, token: null, completed_at: now(), reason: body.reason });
      break;
    case "assign":
      managed();
      s.for_id = body.for ?? null;
      break;
    default:
      fail(400, "invalid_argument", "Unknown task action.");
  }
  const msg = body.result ? postReply(t, user.id, body.result) : null;
  emit(t.board_id, "thread.updated", { thread_id: t.id, actor_id: user.id });
  return { thread: threadView(t, user.id, origin), message: msg ? messageView(msg) : null };
});

route("POST", "/api/boards/:bid/tasks/claim", async ({ user, p, body, origin }) => {
  requireMember(p.bid, user.id, "contributor");
  await delay(200);
  let t;
  if (body.thread_id) {
    t = threads.get(body.thread_id);
    if (!t || t.board_id !== p.bid || !t.task) fail(404, "not_found", "Task not found.");
    if (t.task.state === "claimed" && t.task.assignee_id === user.id) return { thread: threadView(t, user.id, origin), claim: { epoch: t.task.epoch, token: t.task.token, until: t.task.lease_until } };
    if (t.task.state === "claimed") fail(409, "task_already_claimed", "Someone else claimed this task first.");
    if (t.task.state !== "ready") fail(409, "task_finished", "Only ready tasks can be claimed.");
  } else {
    t = [...threads.values()]
      .filter((x) => x.board_id === p.bid && x.task?.state === "ready" && (!x.task.for_id || x.task.for_id === user.id))
      .filter((x) => Object.entries(body.labels || {}).every(([k, v]) => x.labels[k] === v))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!t) fail(404, "no_task_available", "No ready task matches.");
  }
  const claim = { epoch: (t.task.epoch ?? 0) + 1, token: id("tok"), until: new Date(Date.now() + 5 * 60_000).toISOString() };
  Object.assign(t.task, { state: "claimed", assignee_id: user.id, claimed_at: now(), lease_until: claim.until, epoch: claim.epoch, token: claim.token });
  t.last_activity_at = now();
  emit(p.bid, "thread.updated", { thread_id: t.id, actor_id: user.id });
  return { thread: threadView(t, user.id, origin), claim };
});

route("POST", "/api/threads/:tid/task/renew", ({ user, p, body, origin }) => {
  const t = threadFor(p.tid, user.id, "contributor");
  if (!t.task || t.task.state !== "claimed" || t.task.assignee_id !== user.id || t.task.token !== body.token) fail(409, "claim_lost", "This claim is over.");
  t.task.lease_until = new Date(Date.now() + 5 * 60_000).toISOString();
  emit(t.board_id, "thread.updated", { thread_id: t.id, actor_id: user.id });
  return { thread: threadView(t, user.id, origin), claim: { epoch: t.task.epoch, token: t.task.token, until: t.task.lease_until } };
});

route("GET", "/api/inbox", ({ user, q }) => {
  let items = inbox.filter((i) => i.principal_id === user.id && boards.has(i.board_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const unread_count = items.filter((i) => !i.read_at).length;
  if (q.get("unread_only") === "true") items = items.filter((i) => !i.read_at);
  const limit = Number(q.get("limit") || 25);
  const offset = Number(q.get("page_cursor") || 0);
  return {
    items: items.slice(offset, offset + limit).map(inboxView),
    unread_count,
    next_page_cursor: offset + limit < items.length ? String(offset + limit) : null,
    as_of: cursorOf(inboxSeq),
  };
});

route("POST", "/api/inbox/read", ({ user, body }) => {
  let marked = 0;
  const upTo = body.up_to_cursor ? seqOf(body.up_to_cursor) : null;
  for (const it of inbox) {
    if (it.principal_id !== user.id || it.read_at) continue;
    if ((body.item_ids && body.item_ids.includes(it.id)) || (upTo !== null && it.seq <= upTo)) {
      it.read_at = now();
      marked++;
    }
  }
  return { marked, unread_count: inbox.filter((i) => i.principal_id === user.id && !i.read_at).length };
});

route("GET", "/api/boards/:bid/search", ({ user, p, q }) => {
  requireMember(p.bid, user.id);
  const needle = (q.get("query") || "").toLowerCase();
  const results = messages
    .filter((m) => m.board_id === p.bid && !m.deleted && m.body?.toLowerCase().includes(needle))
    .slice(0, 20)
    .map((m) => ({ message: messageView(m), thread_title: threads.get(m.thread_id)?.title ?? "", snippet: m.body.slice(0, 120) }));
  return { results };
});

route("GET", "/api/boards/:bid/members", ({ user, p }) => {
  requireMember(p.bid, user.id);
  return { members: memberships.filter((m) => m.board_id === p.bid).map(memberView) };
});

route("PATCH", "/api/boards/:bid/members/:pid", ({ user, p, body }) => {
  requireMember(p.bid, user.id, "owner");
  const m = membership(p.bid, p.pid);
  if (!m) fail(404, "not_found", "Member not found.");
  if (m.role === "owner") fail(400, "invalid_argument", "The owner's role can't change.");
  if (body.role) m.role = body.role;
  if (body.access_ends_at !== undefined) m.access_ends_at = body.access_ends_at;
  emit(p.bid, "member.updated", { actor_id: user.id, member: memberView(m) });
  return { member: memberView(m) };
});

function removeMember(bid, pid, actorId, reason = "removed") {
  const gone = memberships.filter((m) => m.board_id === bid && (m.principal_id === pid || principals.get(m.principal_id)?.owner_id === pid));
  memberships = memberships.filter((m) => !gone.includes(m));
  for (const m of gone) {
    endAccess(bid, m.principal_id, reason);
    emit(bid, "member.left", { actor_id: actorId, member: memberView(m) });
  }
}

route("DELETE", "/api/boards/:bid/members/:pid", ({ user, p }) => {
  requireMember(p.bid, user.id, "owner");
  const m = membership(p.bid, p.pid);
  if (!m) fail(404, "not_found", "Member not found.");
  if (m.role === "owner") fail(400, "invalid_argument", "The owner can't be removed.");
  removeMember(p.bid, p.pid, user.id);
  return { removed: true };
});

route("GET", "/api/boards/:bid/invites", ({ user, p }) => {
  requireMember(p.bid, user.id, "owner");
  return { invites: invites.filter((i) => i.board_id === p.bid).map((i) => ({ ...i, url: null, created_by: ref(i.created_by) })).reverse() };
});

route("POST", "/api/boards/:bid/invites", ({ user, p, body, origin }) => {
  requireMember(p.bid, user.id, "owner");
  if (body.audience !== "link" && !body.value) fail(400, "invalid_argument", "Enter an email address or domain.");
  if (body.audience === "domain" && /^(gmail|outlook|yahoo|hotmail)\./.test(body.value)) fail(400, "invalid_argument", "Free email domains can't be used for domain invites.");
  const token = randomBytes(16).toString("base64url");
  const inv = addInvite({
    board_id: p.bid,
    audience: body.audience,
    audience_value: body.value || null,
    role: body.role,
    join_by: body.join_by ?? (body.audience === "email" ? null : ahead(60 * 24 * 7)),
    access_ends_at: body.access_ends_at ?? null,
    max_uses: body.audience === "email" ? 1 : (body.max_uses ?? null),
    created_by: user.id,
    created_at: now(),
  }, token);
  return { invite: { ...inv, url: `${origin}/i/${token}`, created_by: ref(user.id) } };
});

route("DELETE", "/api/invites/:iid", ({ user, p }) => {
  const inv = invites.find((i) => i.id === p.iid);
  if (!inv) fail(404, "not_found", "Invite not found.");
  requireMember(inv.board_id, user.id, "owner");
  inv.disabled_at = now();
  return { deleted: true };
});

function inviteByToken(token) {
  const inv = invites.find((i) => i.id === inviteTokens.get(token));
  if (!inv) fail(404, "not_found", "Invite not found.");
  return inv;
}
const inviteStatus = (inv) =>
  inv.disabled_at ? "disabled" : inv.join_by && inv.join_by < now() ? "expired" : inv.max_uses !== null && inv.uses >= inv.max_uses ? "used_up" : "active";

route("GET", "/api/invite-links/:token", ({ p }) => {
  const inv = inviteByToken(p.token);
  return {
    board_name: boards.get(inv.board_id)?.name ?? "Deleted board",
    inviter: principals.get(inv.created_by)?.display_name ?? "Someone",
    role: inv.role,
    audience: inv.audience,
    join_by: inv.join_by,
    access_ends_at: inv.access_ends_at,
    status: inviteStatus(inv),
  };
});

route("POST", "/api/invite-links/:token/redeem", async ({ user, p, origin }) => {
  const inv = inviteByToken(p.token);
  await delay(300);
  const status = inviteStatus(inv);
  if (status === "expired" || status === "used_up") fail(410, "invite_expired", "This invite has expired.");
  if (status === "disabled") fail(410, "invite_disabled", "This invite was disabled.");
  if (inv.audience === "email" && inv.audience_value !== user.email)
    fail(403, "invite_not_eligible", "This invite is for a different email address.", { reason: `This invite is for a different email address than ${user.email}.` });
  if (p.token === "full-board") fail(409, "member_limit_reached", "This board is full.");
  const board = boards.get(inv.board_id);
  if (!membership(board.id, user.id)) {
    join_(board.id, user.id, inv.role, { joined_at: now(), access_ends_at: inv.access_ends_at });
    inv.uses++;
    emit(board.id, "member.joined", { actor_id: user.id, member: memberView(membership(board.id, user.id)) });
  }
  return { board: boardView(board, user.id, origin) };
});

route("GET", "/api/agents", ({ user }) => ({ agents: [...principals.values()].filter((x) => x.kind === "agent" && x.owner_id === user.id).map((a) => agentView(a.id)) }));

route("POST", "/api/agents", ({ user, body }) => {
  if (!body.display_name?.trim()) fail(400, "invalid_argument", "Name the agent.");
  const a = { id: id("p"), kind: "agent", display_name: body.display_name.trim(), email: null, owner_id: user.id };
  principals.set(a.id, a);
  return { agent: agentView(a.id) };
});

route("DELETE", "/api/agents/:aid", ({ user, p }) => {
  const a = principals.get(p.aid);
  if (!a || a.owner_id !== user.id) fail(404, "not_found", "Agent not found.");
  disabledAgents.add(a.id);
  for (const m of memberships.filter((x) => x.principal_id === a.id)) removeMember(m.board_id, a.id, user.id);
  return { deleted: true };
});

route("POST", "/api/agents/:aid/tokens", ({ user, p }) => {
  const a = principals.get(p.aid);
  if (!a || a.owner_id !== user.id) fail(404, "not_found", "Agent not found.");
  const token = `omb_ag_${randomBytes(24).toString("base64url")}`;
  const t = { id: id("tok"), agent_id: a.id, prefix: token.slice(0, 11), created_at: now(), last_used_at: null };
  agentTokens.push(t);
  return { id: t.id, token, prefix: t.prefix };
});

route("DELETE", "/api/agents/:aid/tokens/:tokid", ({ p }) => {
  const i = agentTokens.findIndex((t) => t.id === p.tokid && t.agent_id === p.aid);
  if (i === -1) fail(404, "not_found", "Token not found.");
  agentTokens.splice(i, 1);
  return { revoked: true };
});

route("POST", "/api/boards/:bid/agents", ({ user, p, body }) => {
  const { board, member } = requireMember(p.bid, user.id);
  const a = principals.get(body.agent_id);
  if (!a || a.owner_id !== user.id) fail(404, "not_found", "Agent not found.");
  if (!board.settings.members_can_add_agents && member.role !== "owner") fail(403, "forbidden", "The owner turned off adding agents.");
  if (member.role === "reader" && body.role === "contributor") fail(403, "forbidden", "An agent's role can't be above yours.");
  if (membership(p.bid, a.id)) fail(409, "conflict", "That agent is already on this board.");
  join_(p.bid, a.id, body.role, { joined_at: now() });
  const m = memberView(membership(p.bid, a.id));
  emit(p.bid, "member.joined", { actor_id: user.id, member: m });
  return { member: m };
});

route("GET", "/api/tokens", () => ({ tokens: personalTokens }));
route("POST", "/api/tokens", ({ body }) => {
  const token = `omb_pat_${randomBytes(24).toString("base64url")}`;
  const t = { id: id("pat"), prefix: token.slice(0, 12), label: body.label || null, created_at: now(), last_used_at: null };
  personalTokens.push(t);
  return { id: t.id, token, prefix: t.prefix };
});
route("DELETE", "/api/tokens/:tokid", ({ p }) => {
  const i = personalTokens.findIndex((t) => t.id === p.tokid);
  if (i === -1) fail(404, "not_found", "Token not found.");
  personalTokens.splice(i, 1);
  return { revoked: true };
});

route("GET", "/api/boards/:bid/usage", ({ user, p }) => {
  requireMember(p.bid, user.id, "owner");
  const reset = firstOfNextMonth();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  const members = memberships.filter((m) => m.board_id === p.bid).length;
  return {
    board_id: p.bid,
    allowances: [
      { allowance: "posts", used: 1720, limit: 2000, unit: "count", resets_at: reset, warning: true },
      { allowance: "storage", used: 12_582_912, limit: 104_857_600, unit: "bytes", resets_at: null, warning: false },
      { allowance: "members", used: members, limit: 10, unit: "count", resets_at: null, warning: members >= 8 },
      { allowance: "live_connections", used: [...boardClients].filter((c) => c.board_id === p.bid).length, limit: 20, unit: "count", resets_at: null, warning: false },
      { allowance: "webhook_subscriptions", used: 1, limit: 50, unit: "count", resets_at: null, warning: false },
      { allowance: "boards_owned", used: 1, limit: 1, unit: "count", resets_at: null, warning: true },
      { allowance: "agent_posts", used: 40, limit: 200, unit: "count", resets_at: tomorrow.toISOString(), warning: false },
    ],
    storage_formula: "UTF-8 bytes of live message bodies and thread titles: 12,582,912 of 104,857,600",
  };
});

route("GET", "/api/boards/:bid/export", ({ user, p, origin }) => {
  const { board } = requireMember(p.bid, user.id, "owner");
  const authorIds = new Set(messages.filter((m) => m.board_id === board.id).map((m) => m.author_id));
  const file = {
    format: "openmessageboard.export/0.1",
    exported_at: now(),
    source_host: new URL(origin).host,
    board: { name: board.name, created_at: board.created_at },
    authors: [...authorIds].map((aid) => {
      const r = ref(aid);
      return { ref: aid, kind: r.kind, display_name: r.display_name, via_ref: r.via?.id ?? null };
    }),
    threads: [...threads.values()]
      .filter((t) => t.board_id === board.id)
      .map((t) => ({ id: t.id, title: t.title, kind: t.kind, labels: t.labels, task_state: t.task?.state ?? null, task_assignee_ref: t.task?.assignee_id ?? null, created_by_ref: t.created_by, created_at: t.created_at })),
    messages: messages
      .filter((m) => m.board_id === board.id)
      .map((m) => ({ id: m.id, thread_id: m.thread_id, author_ref: m.author_id, body: m.deleted ? null : m.body, deleted: m.deleted, reply_to: m.reply_to, mention_refs: m.mention_ids, source: m.source, created_at: m.created_at })),
  };
  return [200, file, { "Content-Disposition": `attachment; filename="${board.name.replace(/[^A-Za-z0-9-]+/g, "-")}-export.json"` }];
});

route("POST", "/api/import", ({ user, body, origin }) => {
  if (body.format !== "openmessageboard.export/0.1") fail(400, "invalid_argument", "Not an OpenMessageBoard 0.1 export.");
  const b = { id: id("b"), name: `${body.board?.name ?? "Imported"} (imported)`, owner_id: user.id, created_at: now(), is_personal: false, settings: { ...DEFAULT_SETTINGS } };
  boards.set(b.id, b);
  join_(b.id, user.id, "owner", { joined_at: now() });
  const tmap = new Map();
  for (const t of body.threads || []) {
    const nt = { id: id("t"), board_id: b.id, title: t.title, kind: t.kind, labels: t.labels || {}, task: t.task_state ? { state: t.task_state === "claimed" ? "ready" : t.task_state, assignee_id: null, claimed_at: null, completed_at: null } : null, created_by: user.id, created_at: t.created_at, last_activity_at: t.created_at, links: [] };
    tmap.set(t.id, nt.id);
    addThread(nt);
  }
  for (const m of body.messages || []) {
    if (!tmap.has(m.thread_id)) continue;
    addMessage({ id: id("m"), board_id: b.id, thread_id: tmap.get(m.thread_id), author_id: user.id, body: m.body, deleted: m.deleted, created_at: m.created_at });
  }
  return { board: boardView(b, user.id, origin) };
});

const integrationView = (i, origin) => ({ ...i, webhook_url: `${origin}/api/webhooks/${i.platform}/${i.id}` });

route("GET", "/api/boards/:bid/integrations", ({ user, p, origin }) => {
  requireMember(p.bid, user.id, "owner");
  return { integrations: integrations.filter((i) => i.board_id === p.bid).map((i) => integrationView(i, origin)) };
});

route("POST", "/api/boards/:bid/integrations", async ({ user, p, body, origin }) => {
  requireMember(p.bid, user.id, "owner");
  const empty = Object.entries({ ...body.config, ...body.secrets }).find(([, v]) => !v);
  if (empty) fail(400, "invalid_argument", `${empty[0].replace(/_/g, " ")} is required.`);
  await delay(300);
  const i = { id: id("int"), board_id: p.bid, platform: body.platform, name: body.name, config: body.config, created_at: now(), last_event_at: null, last_error: null };
  integrations.push(i);
  return { integration: integrationView(i, origin) };
});

route("DELETE", "/api/integrations/:iid", ({ user, p }) => {
  const i = integrations.findIndex((x) => x.id === p.iid);
  if (i === -1) fail(404, "not_found", "Integration not found.");
  requireMember(integrations[i].board_id, user.id, "owner");
  integrations.splice(i, 1);
  return { deleted: true };
});

route("POST", "/api/threads/:tid/links", async ({ user, p, body }) => {
  const t = threadFor(p.tid, user.id, "owner");
  const integ = integrations.find((i) => i.id === body.integration_id && i.board_id === t.board_id);
  if (!integ) fail(404, "not_found", "Integration not found.");
  await delay(300);
  const n = Math.floor(Math.random() * 900) + 100;
  const ext =
    body.external_ref ||
    (integ.platform === "github" ? `${integ.config.repo}#${n}` : integ.platform === "linear" ? `${integ.config.team_key}-${n}` : `${integ.config.channel_id}/1732390000.000${n}`);
  const link = { id: id("l"), platform: integ.platform, external_ref: ext, url: `https://${integ.platform}.example/${encodeURIComponent(ext)}` };
  t.links.push(link);
  emit(t.board_id, "thread.updated", { thread_id: t.id, actor_id: user.id });
  return { link };
});

route("DELETE", "/api/links/:lid", ({ user, p }) => {
  for (const t of threads.values()) {
    const i = t.links.findIndex((l) => l.id === p.lid);
    if (i !== -1) {
      requireMember(t.board_id, user.id, "owner");
      t.links.splice(i, 1);
      emit(t.board_id, "thread.updated", { thread_id: t.id, actor_id: user.id });
      return { deleted: true };
    }
  }
  fail(404, "not_found", "Link not found.");
});

route("GET", "/api/boards/:bid/workload-trusts", ({ user, p, origin }) => {
  requireMember(p.bid, user.id, "owner");
  return { trusts: trusts.filter((t) => t.board_id === p.bid).map((t) => ({ ...t, audience: t.audience || origin })) };
});

route("POST", "/api/boards/:bid/workload-trusts", ({ user, p, body, origin }) => {
  requireMember(p.bid, user.id, "owner");
  try {
    new URL(body.issuer);
  } catch {
    fail(400, "invalid_argument", "Issuer must be a URL.");
  }
  const t = { id: id("wt"), board_id: p.bid, issuer: body.issuer, audience: body.audience || origin, subject_pattern: body.subject_pattern, claims: body.claims || {}, agent_id: id("p"), agent_name: body.agent_name, role: body.role, created_at: now(), last_used_at: null };
  trusts.push(t);
  return { trust: t };
});

route("DELETE", "/api/workload-trusts/:wid", ({ user, p }) => {
  const i = trusts.findIndex((t) => t.id === p.wid);
  if (i === -1) fail(404, "not_found", "Trust not found.");
  requireMember(trusts[i].board_id, user.id, "owner");
  trusts.splice(i, 1);
  return { deleted: true };
});

route("GET", "/api/oauth/consent", ({ user, q }) => {
  if (!q.get("client_id")) fail(400, "invalid_argument", "This consent link is missing its client. Start again from your app.");
  return {
    client_name: q.get("client_id") === "cli" ? "omb command line" : "Example Desktop Client",
    client_uri: "https://client.example",
    scopes: ["openid", "boards:read", "boards:write", "offline_access"],
    agents: [...principals.values()].filter((x) => x.kind === "agent" && x.owner_id === user.id && !disabledAgents.has(x.id)).map((a) => ({ id: a.id, display_name: a.display_name })),
  };
});

route("POST", "/api/oauth/consent", ({ body, origin }) => {
  const params = new URLSearchParams(body.oauth_query);
  const as = body.act_as === "self" ? "self" : body.act_as.agent_id ? `agent:${body.act_as.agent_id}` : `new:${body.act_as.new_agent_name}`;
  const target = new URL("/__mock/oauth-callback", origin);
  if (body.accept) target.searchParams.set("code", randomUUID());
  else target.searchParams.set("error", "access_denied");
  target.searchParams.set("state", params.get("state") || "");
  target.searchParams.set("as", as);
  return { redirect_url: target.toString() };
});

/* ---------------- Streams ---------------- */

function openSse(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  res.on("close", () => clearInterval(keepalive));
}

function boardStream(req, res, user, bid, q, origin) {
  requireMember(bid, user.id);
  const cursor = q.get("cursor") || req.headers["last-event-id"];
  openSse(res);
  sse(res, "ready", { cursor: cursorOf(seq) });
  if (cursor) {
    const after = seqOf(cursor);
    const oldest = events[0]?.seq ?? seq;
    if (after && after < oldest - 1 && events.length) sse(res, "resync", { reason: "cursor_expired" });
    else for (const e of events.filter((x) => x.board_id === bid && x.seq > after)) sse(res, "change", changeView(e, user.id, origin), cursorOf(e.seq));
  }
  const client = { res, board_id: bid, pid: user.id, origin };
  boardClients.add(client);
  res.on("close", () => boardClients.delete(client));
}

function inboxStream(req, res, user, q) {
  const cursor = q.get("cursor") || req.headers["last-event-id"];
  openSse(res);
  sse(res, "ready", { cursor: cursorOf(inboxSeq) });
  if (cursor) {
    const after = seqOf(cursor);
    for (const it of inbox.filter((i) => i.principal_id === user.id && i.seq > after)) sse(res, "inbox", inboxView(it), cursorOf(it.seq));
  }
  const client = { res, pid: user.id };
  inboxClients.add(client);
  res.on("close", () => inboxClients.delete(client));
}

/* ---------------- Mock helpers ---------------- */

function mockHelper(path, q) {
  if (path === "/__mock/post") {
    const t = threads.get(q.get("thread") || "t_ship");
    return { message: messageView(postReply(t, "p_maya", q.get("body") || "@ada quick check: are we still on for Friday?", { mention_ids: ["p_ada"] })) };
  }
  if (path === "/__mock/resync") {
    for (const c of boardClients) sse(c.res, "resync", { reason: "cursor_expired" });
    return { ok: true };
  }
  if (path === "/__mock/remove") {
    removeMember(q.get("board") || "b_launch", q.get("principal") || "p_ada", "p_ada");
    return { ok: true };
  }
  return null;
}

/* ---------------- Static files ---------------- */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json" };

async function serveStatic(res, pathname) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, safe);
  if (!file.startsWith(DIST)) file = join(DIST, "index.html");
  try {
    if (!(await stat(file)).isFile()) throw new Error("dir");
  } catch {
    file = join(DIST, "index.html");
  }
  try {
    const data = await readFile(file);
    const immutable = file.includes(`${join(DIST, "assets")}`);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Build the client first: cd web && node_modules/.bin/vite build");
  }
}

/* ---------------- Server ---------------- */

createServer(async (req, res) => {
  const origin = `http://${req.headers.host || `localhost:${PORT}`}`;
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const q = url.searchParams;
  try {
    if (path.startsWith("/__mock/")) {
      if (path === "/__mock/oauth-callback") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><title>Client callback</title><body style="font-family:system-ui;padding:40px"><h1>The MCP client received the redirect</h1><pre>${[...q].map(([k, v]) => `${k}=${v}`).join("\n").replace(/</g, "&lt;")}</pre><p><a href="/">Back to OpenMessageBoard</a></p></body>`);
      }
      const out = mockHelper(path, q);
      return out ? send(res, 200, out) : send(res, 404, { error: { code: "not_found", message: "Unknown mock helper." } });
    }
    if (path === "/api/inbox/stream") return inboxStream(req, res, requireUser(req), q);
    const streamMatch = /^\/api\/boards\/([^/]+)\/stream$/.exec(path);
    if (streamMatch) return boardStream(req, res, requireUser(req), streamMatch[1], q, origin);

    if (path.startsWith("/api/") || path.startsWith("/.well-known/")) {
      const r = routes.find((x) => x.method === req.method && x.re.test(path));
      if (!r) fail(404, "not_found", `No route for ${req.method} ${path}.`);
      const p = Object.fromEntries(Object.entries(r.re.exec(path).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const body = req.method === "GET" ? {} : await readBody(req);
      const isPublic = path.startsWith("/.well-known/") || path.startsWith("/api/auth/") || path.startsWith("/api/sign-in/") || path === "/api/session" || path === "/api/test/outbox" || (req.method === "GET" && path.startsWith("/api/invite-links/"));
      const user = isPublic ? sessionOf(req) : requireUser(req);
      const out = await r.handler({ req, res, user, p, q, body, origin });
      if (Array.isArray(out)) return send(res, out[0], out[1], out[2]);
      return send(res, 200, out);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: { code: "invalid_argument", message: "Method not allowed." } });
    return serveStatic(res, path);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    console.error(e);
    return send(res, 500, { error: { code: "internal", message: "The mock server hit an error." } });
  }
}).listen(PORT, () => {
  console.log(`OpenMessageBoard mock API and client on http://localhost:${PORT}`);
  console.log("Sign in as ada@example.com with any 6-digit code.");
});

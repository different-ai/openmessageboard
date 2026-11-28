import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "@openmessageboard/core/context";
import { OmbError } from "@openmessageboard/core/errors";
import { actorFromPrincipal, getPrincipal } from "@openmessageboard/core/domain/access";
import { createAgent, ensureOwnBoard, getBoard, listMembers } from "@openmessageboard/core/domain/boards";
import { boardChanges, getChanges, getInbox, waitForActivity } from "@openmessageboard/core/domain/changes";
import { createChannel, createGrant, explainAccess, listChannels, listGrants, revokeGrant, updateGrant } from "@openmessageboard/core/domain/channels";
import { deleteMessage, getThread, listThreads, reply, setFollow, startThread } from "@openmessageboard/core/domain/conversation";
import { readMessages } from "@openmessageboard/core/domain/filters";
import { createInvite, redeemInvite } from "@openmessageboard/core/domain/invites";
import { ensureProfile, listActors, profileActor } from "@openmessageboard/core/domain/profiles";
import { saveBoard, savedBoards, unsaveBoard } from "@openmessageboard/core/domain/public";
import { setSubscription } from "@openmessageboard/core/domain/subscriptions";
import { getAttachment, uploadAttachment } from "@openmessageboard/core/domain/attachments";
import { getUsage, searchMessages } from "@openmessageboard/core/domain/usage";
import { authorize, EventsError } from "@openmessageboard/core/mcp/events";
import type { Actor } from "@openmessageboard/core/domain/model";
import { human, key, makeCtx } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof OmbError && e.code === c;
const PUBLIC = [{ kind: "public" as const }];

/** A board with members, an outsider with an account, and one thread in each of `announcements` and `dev`. */
async function world(ctx: AppContext) {
  const owner = human(ctx, "owner@example.test", "Owner");
  const board = ensureOwnBoard(ctx, owner, { create: true })!;
  const join = (email: string, name: string, role: "reader" | "contributor") => {
    const a = human(ctx, email, name);
    redeemInvite(ctx, a, createInvite(ctx, owner, board.id, { audience: "email", value: email, role }).url!);
    return a;
  };
  const maya = join("maya@example.test", "Maya", "contributor");
  const rita = join("rita@example.test", "Rita", "reader");
  const out = human(ctx, "out@elsewhere.test", "Outsider");
  const post = (channel: string, title: string, by: Actor = owner) => startThread(ctx, by, board.id, { channel, title, body: `${title} body`, idempotency_key: key() });
  const news = post("announcements", "Release 2.0");
  const dev = post("dev", "Secret roadmap");
  const open = (can: Record<string, "none" | "read"[]> = { "announcements/": ["read"] }) => createGrant(ctx, owner, board.id, { principals: PUBLIC, can }).grant;
  return { owner, maya, rita, out, boardId: board.id, news, dev, post, open };
}

test("a board with no public grant is as private as before", async () => {
  const ctx = await makeCtx();
  const { out, boardId, news } = await world(ctx);
  assert.throws(() => getBoard(ctx, out, boardId), code("not_found"));
  assert.throws(() => listThreads(ctx, out, boardId, {}), code("not_found"));
  assert.throws(() => getThread(ctx, out, news.thread.id), code("not_found"));
  assert.throws(() => listChannels(ctx, out, boardId), code("not_found"));
  assert.throws(() => readMessages(ctx, out, boardId, {}), code("not_found"));
  assert.throws(() => searchMessages(ctx, out, boardId, "Release"), code("not_found"));
  assert.throws(() => getChanges(ctx, out, { board_id: boardId }), code("not_found"));
  assert.throws(() => startThread(ctx, out, boardId, { title: "x", body: "x", idempotency_key: key() }), code("not_found"));
  assert.throws(() => saveBoard(ctx, out, boardId), code("not_found"));
});

test("someone who is not a member reads what a public grant covers, and nothing else", async () => {
  const ctx = await makeCtx();
  const { owner, maya, out, boardId, news, dev, open, post } = await world(ctx);
  const before = getChanges(ctx, owner, { board_id: boardId }).cursor;
  open();

  const board = getBoard(ctx, out, boardId);
  assert.deepEqual([board.visibility, board.my_access, board.my_role, board.my_access_ends_at], ["public", "public", null, null]);
  assert.equal(getBoard(ctx, maya, boardId).my_access, "member");
  assert.equal(getBoard(ctx, maya, boardId).visibility, "public");

  const channels = listChannels(ctx, out, boardId).channels;
  assert.deepEqual(channels.map((c) => [c.path, c.public, c.my_permissions]), [["announcements", true, ["read"]]]);
  assert.equal(listChannels(ctx, maya, boardId).channels.find((c) => c.path === "dev")!.public, false);

  assert.deepEqual(listThreads(ctx, out, boardId, {}).threads.map((t) => t.title), ["Release 2.0"]);
  assert.equal(getThread(ctx, out, news.thread.id).messages[0]!.body, "Release 2.0 body");
  assert.throws(() => getThread(ctx, out, dev.thread.id), code("not_found"));
  assert.deepEqual(readMessages(ctx, out, boardId, {}).messages.map((m) => m.id), [news.message.id]);
  assert.deepEqual(searchMessages(ctx, out, boardId, "body").results.map((r) => r.message.id), [news.message.id]);
  assert.equal(searchMessages(ctx, out, boardId, "roadmap").results.length, 0);

  // Reading leaves nothing behind.
  assert.equal((ctx.db.prepare("SELECT COUNT(*) AS n FROM read_markers WHERE principal_id = ?").get(out.id) as { n: number }).n, 0);

  // Changes: thread and message changes in public channels. Who joined, and changes to the board, are for members.
  const joiner = human(ctx, "new@example.test", "New");
  redeemInvite(ctx, joiner, createInvite(ctx, owner, boardId, { audience: "email", value: "new@example.test", role: "reader" }).url!);
  post("dev", "More secrets");
  const second = post("announcements", "Release 2.1");
  const page = getChanges(ctx, out, { board_id: boardId, cursor: before });
  assert.deepEqual(page.changes.map((c) => [c.type, c.thread_id]), [["thread.created", second.thread.id]]);
  const forMembers = getChanges(ctx, owner, { board_id: boardId, cursor: before }).changes.map((c) => c.type);
  assert.ok(forMembers.includes("member.joined") && forMembers.includes("board.updated"), "members still see them");

  // Their own access: whether they can read, and through which pattern. Never which grants the board has.
  const why = explainAccess(ctx, out, boardId, "announcements");
  assert.deepEqual([why.level, why.role, why.can, why.pattern, why.grant_ids], ["public", null, ["read"], "announcements/", []]);
  const closed = explainAccess(ctx, out, boardId, "dev");
  assert.deepEqual([closed.level, closed.can, closed.pattern, closed.grant_ids], [null, [], null, []]);
  assert.throws(() => explainAccess(ctx, out, boardId, "announcements", maya.id), code("forbidden"));
});

test("a public reader does nothing but read: what they can see is forbidden to change, the rest stays not_found", async () => {
  const ctx = await makeCtx();
  const { owner, out, boardId, news, dev, open } = await world(ctx);
  open();
  const text = { body: "hello", idempotency_key: key() };
  // The board, named directly: it is known to exist.
  assert.throws(() => startThread(ctx, out, boardId, { title: "Hi", ...text }), code("forbidden"));
  assert.throws(() => listMembers(ctx, out, boardId), code("forbidden"));
  assert.throws(() => listActors(ctx, out, boardId), code("forbidden"));
  assert.throws(() => listGrants(ctx, out, boardId), code("forbidden"));
  assert.throws(() => getUsage(ctx, out, boardId), code("forbidden"));
  assert.throws(() => setSubscription(ctx, out, boardId, "*", "all"), code("forbidden"));
  assert.throws(() => createChannel(ctx, out, boardId, { path: "mine" }), code("forbidden"));
  await assert.rejects(waitForActivity(ctx, out, { board_id: boardId, cursor: getChanges(ctx, out, { board_id: boardId }).cursor, timeout_seconds: 1 }), code("forbidden"));
  // A thread or a message they can read.
  assert.throws(() => reply(ctx, out, news.thread.id, text), code("forbidden"));
  assert.throws(() => setFollow(ctx, out, news.thread.id, true), code("forbidden"));
  assert.throws(() => deleteMessage(ctx, out, news.message.id), code("forbidden"));
  await assert.rejects(waitForActivity(ctx, out, { thread_id: news.thread.id, cursor: "x", timeout_seconds: 1 }), code("forbidden"));
  // A thread or a message they cannot read: nothing says it exists.
  assert.throws(() => reply(ctx, out, dev.thread.id, text), code("not_found"));
  assert.throws(() => setFollow(ctx, out, dev.thread.id, true), code("not_found"));
  assert.throws(() => deleteMessage(ctx, out, dev.message.id), code("not_found"));
  // No inbox on the board: a mention of someone who is not a member is refused, as before.
  assert.throws(() => reply(ctx, owner, news.thread.id, { ...text, idempotency_key: key(), mentions: [out.id] }), code("invalid_argument"));
  assert.equal(getInbox(ctx, out, {}).items.length, 0);
  // Events: the public pulls. Polling is allowed; a stream or a webhook subscription is not.
  authorize(ctx, out, "board.message_created", { board_id: boardId }, { allowPublic: true });
  assert.throws(() => authorize(ctx, out, "board.message_created", { board_id: boardId }), (e: unknown) => e instanceof EventsError && e.code === -32024);
  assert.throws(() => authorize(ctx, out, "board.message_created", { board_id: boardId, thread_id: dev.thread.id }, { allowPublic: true }), (e: unknown) => e instanceof EventsError && e.code === -32024);
});

test("handles are for members: a public reader filters by principal ID", async () => {
  const ctx = await makeCtx();
  const { owner, out, boardId, news, open } = await world(ctx);
  open();
  // The answer must not say which handles the board's members have.
  for (const handle of ["owner", "maya", "nobody-has-this"]) assert.throws(() => readMessages(ctx, out, boardId, { by: handle }), code("invalid_argument"));
  assert.deepEqual(readMessages(ctx, out, boardId, { by: owner.id }).messages.map((m) => m.id), [news.message.id]);
  assert.equal(readMessages(ctx, owner, boardId, { by: "owner" }).messages.length, 2, "members still use handles");
});

test("agents: a public board is read only after their person saved it", async () => {
  const ctx = await makeCtx();
  const { owner, maya, out, boardId, news, open } = await world(ctx);
  open();
  const profile = profileActor(out, ensureProfile(ctx, out, "scout"));
  const agent = actorFromPrincipal(getPrincipal(ctx, createAgent(ctx, out, "crawler").id)!, "agent_token");
  for (const a of [profile, agent]) {
    assert.throws(() => getBoard(ctx, a, boardId), code("not_found"));
    assert.throws(() => getThread(ctx, a, news.thread.id), code("not_found"));
    assert.throws(() => startThread(ctx, a, boardId, { title: "x", body: "x", idempotency_key: key() }), code("not_found"), "an agent is not told the board exists");
    assert.throws(() => saveBoard(ctx, a, boardId), code("forbidden"));
    assert.deepEqual(savedBoards(ctx, a), []);
  }
  assert.equal(saveBoard(ctx, out, boardId).board.my_access, "public");
  saveBoard(ctx, out, boardId); // saving twice is the same
  for (const a of [profile, agent]) {
    assert.equal(getThread(ctx, a, news.thread.id).thread.title, "Release 2.0");
    assert.deepEqual(savedBoards(ctx, a).map((b) => b.id), [boardId]);
    assert.throws(() => reply(ctx, a, news.thread.id, { body: "x", idempotency_key: key() }), code("forbidden"));
  }
  assert.deepEqual(savedBoards(ctx, out).map((b) => [b.id, b.my_access]), [[boardId, "public"]]);
  // Someone else's agents are not let in by it.
  const other = human(ctx, "other@elsewhere.test", "Other");
  assert.throws(() => getThread(ctx, profileActor(other, ensureProfile(ctx, other, "scout")), news.thread.id), code("not_found"));
  assert.deepEqual(unsaveBoard(ctx, out, boardId), { board_id: boardId, saved: false });
  assert.deepEqual(unsaveBoard(ctx, out, "b_does_not_exist"), { board_id: "b_does_not_exist", saved: false });
  for (const a of [profile, agent]) assert.throws(() => getThread(ctx, a, news.thread.id), code("not_found"));
  // A member's own board that is not public has nothing to save; an unknown board is not found.
  const mine = ensureOwnBoard(ctx, maya, { create: true })!;
  assert.throws(() => saveBoard(ctx, maya, mine.id), code("invalid_argument"));
  assert.throws(() => saveBoard(ctx, out, mine.id), code("not_found"));
  assert.throws(() => saveBoard(ctx, owner, "b_does_not_exist"), code("not_found"));
});

test("a public grant: the owner in person, read or nothing, the public alone, and only where the server offers it", async () => {
  const ctx = await makeCtx();
  const { owner, maya, out, boardId, news, open } = await world(ctx);
  // maya manages announcements/, which is not enough to open it to the public.
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: maya.id }], can: { "announcements/": "all" } });
  const pub = { principals: PUBLIC, can: { "announcements/": ["read" as const] } };
  assert.throws(() => createGrant(ctx, maya, boardId, pub), code("forbidden"));
  assert.throws(() => createGrant(ctx, profileActor(owner, ensureProfile(ctx, owner, "helper")), boardId, pub), code("forbidden"));
  assert.throws(() => createGrant(ctx, { ...owner, scope: { boards: null, can: ["read", "post", "react", "label"], profile: null, expires_at: null } }, boardId, pub), code("forbidden"));
  assert.throws(() => createGrant(ctx, owner, boardId, { principals: PUBLIC, can: { "announcements/": ["read", "post"] } }), code("invalid_argument"));
  assert.throws(() => createGrant(ctx, owner, boardId, { principals: PUBLIC, can: { "*": "all" } }), code("invalid_argument"));
  assert.throws(() => createGrant(ctx, owner, boardId, { principals: [...PUBLIC, { kind: "everyone" }], can: { "*": ["read"] } }), code("invalid_argument"));
  const grant = open();
  assert.deepEqual(grant.principals, PUBLIC);
  // Adding the public to a member grant, or widening a public one, is refused; so is a manager changing or revoking it.
  const memberGrant = createGrant(ctx, owner, boardId, { principals: [{ kind: "readers" }], can: { "dev/": ["read"] } }).grant;
  assert.throws(() => updateGrant(ctx, owner, memberGrant.id, { add: PUBLIC }), code("invalid_argument"));
  assert.throws(() => updateGrant(ctx, owner, grant.id, { can: { "announcements/": ["read", "react"] } }), code("invalid_argument"));
  assert.throws(() => updateGrant(ctx, maya, grant.id, { can: { "announcements/": "none" } }), code("forbidden"));
  assert.throws(() => revokeGrant(ctx, maya, grant.id), code("forbidden"));
  assert.equal(getThread(ctx, out, news.thread.id).thread.id, news.thread.id);

  // A server that does not offer public access: no new public grants, and an existing one opens nothing.
  ctx.config.publicAccess = false;
  assert.throws(() => createGrant(ctx, owner, boardId, pub), code("invalid_argument"));
  assert.throws(() => getThread(ctx, out, news.thread.id), code("not_found"));
  assert.throws(() => getBoard(ctx, out, boardId), code("not_found"));
  ctx.config.publicAccess = true;

  // Revoking ends reading on the next request.
  assert.deepEqual(revokeGrant(ctx, owner, grant.id), { grant_id: grant.id, revoked: true });
  assert.throws(() => getThread(ctx, out, news.thread.id), code("not_found"));
  assert.equal(getBoard(ctx, owner, boardId).visibility, "private");
});

test("the most specific public pattern decides, a private channel stays private, and a member is never worse off than the public", async () => {
  const ctx = await makeCtx();
  const { owner, maya, rita, out, boardId, dev, open, post } = await world(ctx);
  const internal = post("internal/plans", "Plans");
  createChannel(ctx, owner, boardId, { path: "team", private: true });
  const team = post("team", "Salaries");
  open({ "*": ["read"], "internal/": "none" });
  assert.equal(getThread(ctx, out, dev.thread.id).thread.id, dev.thread.id, "read at * opens every channel");
  assert.throws(() => getThread(ctx, out, internal.thread.id), code("not_found"), "except where a closer public pattern gives nothing");
  // Where the public grant gives nothing, a member's own access decides as before: readers read every channel by default.
  assert.equal(getThread(ctx, rita, internal.thread.id).thread.id, internal.thread.id);

  // A private channel is closed to members at its own subtree, which is closer than `*`: the public grant does
  // not open it, to the public or, through the public, to members who are not in it.
  for (const a of [out, rita, maya]) assert.throws(() => getThread(ctx, a, team.thread.id), code("not_found"));
  assert.deepEqual(listThreads(ctx, out, boardId, {}).threads.map((t) => t.title).sort(), ["Release 2.0", "Secret roadmap"]);
  assert.equal(searchMessages(ctx, out, boardId, "Salaries").results.length, 0);
  assert.deepEqual(explainAccess(ctx, out, boardId, "team").can, []);
  const listed = listChannels(ctx, owner, boardId).channels.find((c) => c.path === "team")!;
  assert.deepEqual([listed.private, listed.public], [true, false]);

  // The owner opens it by naming it. Then the public reads it, and so does every member, whatever closes them out.
  open({ "team/": ["read"] });
  assert.equal(getThread(ctx, out, team.thread.id).thread.id, team.thread.id);
  assert.equal(getThread(ctx, rita, team.thread.id).thread.id, team.thread.id);
  assert.deepEqual(explainAccess(ctx, rita, boardId, "team").can, ["read"]);
  const now = listChannels(ctx, rita, boardId).channels.find((c) => c.path === "team")!;
  assert.deepEqual([now.private, now.public, now.my_permissions], [false, true, ["read"]]);
  assert.throws(() => reply(ctx, rita, team.thread.id, { body: "x", idempotency_key: key() }), code("forbidden"), "reading is all the public's access adds");
});

test("the public's access never widens what a member may manage, and follows the server's switch", async () => {
  const ctx = await makeCtx();
  const { owner, maya, rita, boardId, open, post } = await world(ctx);
  // maya manages lab/ without reading it; lab/ is closed to members and open to the public.
  const lab = post("lab/notes", "Experiment");
  createGrant(ctx, owner, boardId, { principals: [{ kind: "member", principal_id: maya.id }], can: { "lab/": ["manage"] } });
  createGrant(ctx, owner, boardId, { principals: [{ kind: "everyone" }], can: { "lab/": "none" } });
  assert.throws(() => getThread(ctx, maya, lab.thread.id), code("not_found"));
  open({ "lab/": ["read"] });
  assert.equal(getThread(ctx, maya, lab.thread.id).thread.id, lab.thread.id, "she reads it as anyone can");
  // She cannot hand out read there: a grant of hers would outlive the public one.
  const give = { principals: [{ kind: "member" as const, principal_id: rita.id }], can: { "lab/": ["read" as const] } };
  assert.throws(() => createGrant(ctx, maya, boardId, give), code("forbidden"));

  // A server that stops offering public access: stored public grants open nothing, to members either.
  ctx.config.publicAccess = false;
  assert.throws(() => getThread(ctx, maya, lab.thread.id), code("not_found"));
  assert.equal(getBoard(ctx, owner, boardId).visibility, "private");
  assert.ok(listChannels(ctx, owner, boardId).channels.every((c) => !c.public));
  ctx.config.publicAccess = true;
  assert.equal(getBoard(ctx, owner, boardId).visibility, "public");
  assert.equal(listChannels(ctx, owner, boardId).channels.find((c) => c.path === "lab/notes")!.public, true);
});

test("what is pushed is for members: change feeds end with a membership, and the public gets no board-wide changes", async () => {
  const ctx = await makeCtx();
  const { owner, maya, out, boardId, news, open, post } = await world(ctx);
  const start = getChanges(ctx, owner, { board_id: boardId }).cursor;
  open();
  const joiner = human(ctx, "new@example.test", "New");
  redeemInvite(ctx, joiner, createInvite(ctx, owner, boardId, { audience: "email", value: "new@example.test", role: "reader" }).url!);
  post("announcements", "Release 2.1");

  // A filter does not let the public see who joined or what the owner changed.
  assert.deepEqual(getChanges(ctx, out, { board_id: boardId, cursor: start, types: ["member.joined", "board.updated"] }).changes, []);
  assert.deepEqual(getChanges(ctx, out, { board_id: boardId, cursor: start, types: ["thread.created", "member.joined"] }).changes.map((c) => c.type), ["thread.created"]);
  assert.ok(getChanges(ctx, owner, { board_id: boardId, cursor: start, types: ["member.joined"] }).changes.length > 0, "members still can");

  // The feed behind wait_for_activity, the browser stream and watchers serves members only.
  assert.throws(() => boardChanges(ctx, out, boardId, start), code("forbidden"));
  assert.ok(boardChanges(ctx, maya, boardId, start).changes.length > 0);
  ctx.db.prepare("UPDATE memberships SET access_ends_at = ? WHERE board_id = ? AND principal_id = ?").run(new Date(Date.now() - 1000).toISOString(), boardId, maya.id);
  assert.throws(() => boardChanges(ctx, maya, boardId, start), code("access_ended"), "it ends with the membership, although the board stays readable");
  assert.ok(getChanges(ctx, maya, { board_id: boardId, cursor: start }).changes.length > 0, "pulling still works");

  // A disabled board: nothing says it is there, to someone who is not a member.
  ctx.db.prepare("UPDATE boards SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), boardId);
  assert.throws(() => reply(ctx, out, news.thread.id, { body: "x", idempotency_key: key() }), code("not_found"));
  assert.throws(() => getThread(ctx, out, news.thread.id), code("not_found"));
});

test("a public reader costs the board nothing: refused writes do not use up its write rate", async () => {
  const ctx = await makeCtx();
  const { owner, out, boardId, news, open, post } = await world(ctx);
  open();
  ctx.config.rateLimits.writes_per_minute_board = 6;
  ctx.config.rateLimits.writes_per_minute_principal = 1000;
  for (let i = 0; i < 12; i++) {
    assert.throws(() => startThread(ctx, out, boardId, { title: "x", body: "x", idempotency_key: key() }), code("forbidden"));
    assert.throws(() => reply(ctx, out, news.thread.id, { body: "x", idempotency_key: key() }), code("forbidden"));
    assert.throws(() => createChannel(ctx, out, boardId, { path: `c${i}` }), code("forbidden"));
  }
  assert.equal(post("announcements", "Still writable").thread.title, "Still writable");
  assert.equal(reply(ctx, owner, news.thread.id, { body: "And again", idempotency_key: key() }).message.body, "And again");
});

test("a task's prerequisites in channels the public cannot read are not shown to the public", async () => {
  const ctx = await makeCtx();
  const { owner, rita, out, boardId, open } = await world(ctx);
  createChannel(ctx, owner, boardId, { path: "team", private: true });
  const task = (channel: string, title: string, needs?: string[]) => startThread(ctx, owner, boardId, { channel, title, body: title, task: true, needs, idempotency_key: key() });
  const hidden = task("team", "Negotiate the contract");
  const shown = task("announcements", "Publish the release notes");
  const release = task("announcements", "Ship 2.0", [hidden.thread.id, shown.thread.id]);
  open();
  const needs = (a: Actor) => getThread(ctx, a, release.thread.id).thread.task!.needs;
  assert.deepEqual(needs(out), [{ thread_id: shown.thread.id, title: "Publish the release notes", state: "ready" }]);
  // A member who is not in the private channel is told a prerequisite exists, without its title, as before.
  assert.deepEqual(needs(rita).map((n) => [n.thread_id, n.title]), [[hidden.thread.id, ""], [shown.thread.id, "Publish the release notes"]]);
});

test("scoped tokens, ended memberships, disabled accounts and attachments", async () => {
  const ctx = await makeCtx();
  const { owner, maya, out, boardId, news, dev, open } = await world(ctx);
  open();
  const scope = (boards: string[] | null) => ({ boards, can: ["read" as const], profile: null, expires_at: null });
  assert.equal(getThread(ctx, { ...out, scope: scope(null) }, news.thread.id).thread.id, news.thread.id);
  assert.equal(getThread(ctx, { ...out, scope: scope([boardId]) }, news.thread.id).thread.id, news.thread.id);
  assert.throws(() => getThread(ctx, { ...out, scope: scope(["b_another"]) }, news.thread.id), code("not_found"), "a token reaches only its boards");

  // A file on a public message is readable; one on a message the public cannot read is not.
  const file = await uploadAttachment(ctx, owner, boardId, { name: "notes.txt", type: "text/plain", data: new TextEncoder().encode("public notes") });
  const hidden = await uploadAttachment(ctx, owner, boardId, { name: "plan.txt", type: "text/plain", data: new TextEncoder().encode("secret plan") });
  reply(ctx, owner, news.thread.id, { body: "With notes", idempotency_key: key(), attachments: [file.attachment.id] });
  reply(ctx, owner, dev.thread.id, { body: "With the plan", idempotency_key: key(), attachments: [hidden.attachment.id] });
  assert.equal((await getAttachment(ctx, out, file.attachment.id)).attachment.name, "notes.txt");
  await assert.rejects(getAttachment(ctx, out, hidden.attachment.id), code("not_found"));

  // A member whose access ended reads what the public reads, and no more: not even a file they uploaded
  // themselves, when the message it is on is out of the public's reach.
  const own = await uploadAttachment(ctx, maya, boardId, { name: "draft.txt", type: "text/plain", data: new TextEncoder().encode("maya's draft") });
  reply(ctx, maya, dev.thread.id, { body: "My draft", idempotency_key: key(), attachments: [own.attachment.id] });
  assert.equal((await getAttachment(ctx, maya, own.attachment.id)).attachment.name, "draft.txt");
  ctx.db.prepare("UPDATE memberships SET access_ends_at = ? WHERE board_id = ? AND principal_id = ?").run(new Date(Date.now() - 1000).toISOString(), boardId, maya.id);
  assert.equal(getThread(ctx, maya, news.thread.id).thread.id, news.thread.id);
  assert.throws(() => getThread(ctx, maya, dev.thread.id), code("not_found"));
  assert.equal(getBoard(ctx, maya, boardId).my_access, "public");
  await assert.rejects(getAttachment(ctx, maya, own.attachment.id), code("not_found"));
  assert.equal((await getAttachment(ctx, maya, file.attachment.id)).attachment.name, "notes.txt");

  // A disabled account reads nothing.
  ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), out.id);
  assert.throws(() => getThread(ctx, out, news.thread.id), code("not_found"));
});

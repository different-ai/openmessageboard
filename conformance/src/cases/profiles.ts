/**
 * Profiles (01 §Profiles) and scoped tokens (01 §Scoped tokens): zero-setup agent identities that act with their
 * person's access, and tokens narrowed to boards, to reading, to a profile, and in time.
 */
import { PROFILE_HEADER } from "@openmessageboard/protocol";
import { check } from "../errors.ts";
import type { Ctx } from "../harness.ts";
import { rawRpc } from "../http.ts";
import type { PrincipalName } from "../identities.ts";
import { McpSession } from "../mcp.ts";
import type { CaseDef } from "../harness.ts";
import { sleep } from "../util.ts";
import { mayaOnOwnerBoard, ownerBoard, quotaReaderOnOwnerBoard, reply, sharedThread, startThread } from "./helpers.ts";

/** A fresh connection for `name` that writes as `profile` (closed at the end of the run). */
async function asProfile(ctx: Ctx, name: PrincipalName, profile: string): Promise<McpSession> {
  await ctx.discovery();
  const s = await McpSession.connect(`${name}/${profile}`, ctx.endpoint, ctx.token(name), 15_000, { [PROFILE_HEADER]: profile });
  ctx.cleanups.push(() => s.close());
  return s;
}

/** A fresh connection with a bearer token minted during the run. */
async function withToken(ctx: Ctx, label: string, token: string, headers?: Record<string, string>): Promise<McpSession> {
  await ctx.discovery();
  const s = await McpSession.connect(label, ctx.endpoint, token, 15_000, headers);
  ctx.cleanups.push(() => s.close());
  return s;
}

export const profileCases: CaseDef[] = [
  {
    id: "core.profile-writes-via",
    profile: "core",
    title: "OMB-Profile writes as the person's profile, shown via the person, and list_actors lists it with its handle",
    covers: ["R01-32", "R01-37", "R02-29"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.me("owner");
      const name = `fx-${ctx.runId}`;
      const fx = await asProfile(ctx, "owner", name);
      const w = await fx.ok("whoami", {});
      check(w.principal.kind === "agent", `a profile's principal.kind is ${w.principal.kind}, expected agent (01 §Profiles)`);
      check(w.principal.profile?.toLowerCase() === name, `whoami.principal.profile is ${String(w.principal.profile)}, expected ${name}`);
      check(w.principal.owner?.id === owner.id, "a profile's principal.owner is its person");
      check(w.principal.email === null, "a profile's email is null");
      check(
        w.memberships.some((m) => m.board_id === board && m.role === "owner"),
        "a profile's memberships are its person's, with the person's role",
      );
      const t = await startThread(fx, board, `Profile ${ctx.runId}`, "Written as a profile.");
      check(t.message.author.id === w.principal.id, "the message's author is the profile");
      check(t.message.author.via?.id === owner.id, `message.author.via is ${JSON.stringify(t.message.author.via)}, expected the person`);
      const upper = await asProfile(ctx, "owner", name.toUpperCase());
      check((await upper.ok("whoami", {})).principal.id === w.principal.id, "profile names match regardless of case (one principal)");
      const { actors } = await (await ctx.session("owner")).ok("list_actors", { board_id: board });
      const listed = actors.find((a) => a.id === w.principal.id);
      const person = actors.find((a) => a.id === owner.id);
      check(listed?.kind === "profile", `list_actors lists the profile with kind "profile", got ${String(listed?.kind)}`);
      check(person, "list_actors lists the owner");
      check(listed.handle === `${person.handle}/${name}`, `the profile's handle is ${listed.handle}, expected ${person.handle}/${name}`);
      check(listed.via?.id === owner.id && listed.is_member, "the profile shows via its person and is_member while the person is a member");
      const emails = [ctx.email("owner"), ctx.email("maya")].map((e) => e.toLowerCase());
      check(!actors.some((a) => emails.some((e) => JSON.stringify(a).toLowerCase().includes(e))), "list_actors never includes email addresses");
    },
  },
  {
    id: "core.profile-inherits-role",
    profile: "core",
    title: "A profile has its person's role on each board with no invite: a contributor's profile posts, a reader's can't, an outsider's sees nothing",
    covers: ["R01-34", "R02-09"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      await quotaReaderOnOwnerBoard(ctx);
      const mayaFx = await asProfile(ctx, "maya", `fx-${ctx.runId}`);
      const t = await startThread(mayaFx, board, `Maya's profile ${ctx.runId}`, "No invite needed.");
      check(t.message.author.via?.id === (await ctx.me("maya")).id, "maya's profile writes via maya");
      const reader = await asProfile(ctx, "quota", `fx-${ctx.runId}`);
      await reader.ok("list_threads", { board_id: board });
      await reader.fails("start_thread", { board_id: board, title: "reader profile", body: "should fail", idempotency_key: `pr-${ctx.runId}-1` }, "forbidden");
      const outsider = await asProfile(ctx, "outsider", `fx-${ctx.runId}`);
      if (await ctx.isMember("outsider", board)) ctx.skip("outsider is a member of the owner's board; use a fresh server");
      await outsider.fails("list_threads", { board_id: board }, "not_found");
      const link = await (await ctx.session("owner")).ok("create_invite", { board_id: board, audience: "link", role: "reader" });
      const e = await outsider.fails("redeem_invite", { invite: link.invite.url! }, "invite_not_eligible");
      check((e.details as { reason?: unknown } | undefined)?.reason === "agent_not_allowed", "a profile can't redeem invites (agent_not_allowed)");
    },
  },
  {
    id: "core.profile-edit-rules",
    profile: "core",
    title: "A profile can delete only what it wrote; its person can delete what any of their profiles wrote",
    covers: ["R01-36", "R02-11", "R02-12"],
    async run(ctx) {
      const { threadId } = await sharedThread(ctx);
      const maya = await ctx.session("maya");
      const fx = await asProfile(ctx, "maya", `fx-${ctx.runId}`);
      const codex = await asProfile(ctx, "maya", `codex-${ctx.runId}`);
      const byMaya = await reply(maya, threadId, "Written by maya herself.");
      await fx.fails("delete_message", { message_id: byMaya.message.id }, "forbidden");
      const byFx = await reply(fx, threadId, "Written by maya's fx profile.");
      await codex.fails("delete_message", { message_id: byFx.message.id }, "forbidden");
      const deleted = await maya.ok("delete_message", { message_id: byFx.message.id });
      check(deleted.message.deleted, "maya (a contributor, not the board owner) deletes what her profile wrote");
      const own = await reply(codex, threadId, "Written by codex.");
      check((await codex.ok("delete_message", { message_id: own.message.id })).message.deleted, "a profile deletes what it wrote");
    },
  },
  {
    id: "core.profile-agent-refused",
    profile: "core",
    title: "An agent's credential with OMB-Profile is refused with 403; a malformed profile name with 400",
    covers: ["R01-33", "R01-38"],
    async run(ctx) {
      await ctx.discovery();
      const agent = await rawRpc(ctx.endpoint, ctx.token("agent"), "tools/list", {}, { headers: { [PROFILE_HEADER]: "fx" } });
      check(agent.status === 403, `an agent token with ${PROFILE_HEADER} got HTTP ${agent.status}, expected 403 (an agent can't write as a profile)`);
      const bad = await rawRpc(ctx.endpoint, ctx.token("owner"), "tools/list", {}, { headers: { [PROFILE_HEADER]: "9 not a name" } });
      check(bad.status === 400, `a malformed profile name got HTTP ${bad.status}, expected 400`);
      const long = await rawRpc(ctx.endpoint, ctx.token("owner"), "tools/list", {}, { headers: { [PROFILE_HEADER]: `a${"b".repeat(32)}` } });
      check(long.status === 400, `a 33-character profile name got HTTP ${long.status}, expected 400`);
    },
  },
  {
    id: "core.scoped-token-read-only",
    profile: "core",
    title: "A read-only scoped token reads as a reader but can't post, invite or mint tokens",
    covers: ["R01-41", "R01-43", "R02-10"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const before = ctx.serverNow();
      const created = await owner.ok("create_scoped_token", { boards: [board], can: ["read"], expires_in_seconds: 600, label: `conformance ${ctx.runId}` });
      check(typeof created.token === "string" && created.token.length >= 20, "create_scoped_token returns the token");
      check(JSON.stringify(created.scope.can) === JSON.stringify(["read"]), `scope.can is ${JSON.stringify(created.scope.can)}`);
      const exp = Date.parse(created.scope.expires_at ?? "");
      check(Number.isFinite(exp) && Math.abs(exp - (before + 600_000)) < 30_000, `scope.expires_at ${created.scope.expires_at} should be about 600 s from now`);
      const s = await withToken(ctx, "owner/read-only", created.token);
      const w = await s.ok("whoami", {});
      check(w.principal.id === (await ctx.me("owner")).id, "a scoped personal token acts as its person");
      check(JSON.stringify(w.principal.scope?.can) === JSON.stringify(["read"]), "whoami.principal.scope shows the token's limits");
      check(w.memberships.every((m) => m.role === "reader"), `a read-only token acts as a reader, got roles ${w.memberships.map((m) => m.role).join(", ")}`);
      await s.ok("list_threads", { board_id: board });
      await s.fails("start_thread", { board_id: board, title: "read-only", body: "should fail", idempotency_key: `ro-${ctx.runId}` }, "forbidden");
      await s.fails("create_invite", { board_id: board, audience: "link", role: "reader" }, "forbidden");
      await s.fails("create_scoped_token", {}, "forbidden");
      await owner.fails("create_scoped_token", { expires_in_seconds: 86_401 }, "invalid_argument");
      await owner.fails("create_scoped_token", { can: ["read", "post"] }, "invalid_argument");
    },
  },
  {
    id: "core.scoped-token-boards",
    profile: "core",
    title: "A board-scoped token sees only its boards; every other board is not_found",
    covers: ["R01-40", "R02-37"],
    async run(ctx) {
      const shared = await sharedThread(ctx);
      const mayaBoard = await ctx.boardOf("maya");
      const maya = await ctx.session("maya");
      await maya.fails("create_scoped_token", { boards: [`b_not_mine_${ctx.runId}`] }, "not_found");
      const created = await maya.ok("create_scoped_token", { boards: [mayaBoard], expires_in_seconds: 600 });
      const s = await withToken(ctx, "maya/board-scoped", created.token);
      const w = await s.ok("whoami", {});
      check(w.memberships.length === 1 && w.memberships[0]!.board_id === mayaBoard, `a board-scoped token lists only its board, got ${w.memberships.map((m) => m.board_id).join(", ")}`);
      await s.fails("list_threads", { board_id: shared.boardId }, "not_found");
      await s.fails("get_thread", { thread_id: shared.threadId }, "not_found");
      await startThread(s, mayaBoard, `Scoped ${ctx.runId}`, "Within the token's board.");
    },
  },
  {
    id: "core.scoped-token-expired",
    profile: "core",
    title: "A token past its expiry is rejected with HTTP 401 invalid_token",
    covers: ["R01-42"],
    async run(ctx) {
      const owner = await ctx.session("owner");
      const created = await owner.ok("create_scoped_token", { expires_in_seconds: 2 });
      const live = await rawRpc(ctx.endpoint, created.token, "tools/list");
      check(live.status === 200, `a fresh scoped token got HTTP ${live.status}`);
      const until = Date.parse(created.scope.expires_at ?? "") - ctx.serverNow();
      await sleep(Math.max(until, 0) + 1500);
      const dead = await rawRpc(ctx.endpoint, created.token, "tools/list");
      check(dead.status === 401, `an expired token got HTTP ${dead.status}, expected 401 (01 §Scoped tokens)`);
    },
  },
  {
    id: "core.scoped-token-profile",
    profile: "core",
    title: "A token scoped to a profile always writes as it; OMB-Profile can't change it",
    covers: ["R01-39"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const name = `sandbox-${ctx.runId}`;
      const created = await owner.ok("create_scoped_token", { profile: name, expires_in_seconds: 600 });
      check(created.scope.profile?.toLowerCase() === name, `scope.profile is ${String(created.scope.profile)}`);
      const s = await withToken(ctx, "owner/sandbox", created.token);
      const t = await startThread(s, board, `Sandbox ${ctx.runId}`, "Written by a sandboxed agent.");
      check(t.message.author.display_name.toLowerCase() === name, `the token wrote as ${t.message.author.display_name}, expected ${name}`);
      check(t.message.author.via?.id === (await ctx.me("owner")).id, "via the person");
      const other = await rawRpc(ctx.endpoint, created.token, "tools/list", {}, { headers: { [PROFILE_HEADER]: "someone-else" } });
      check(other.status === 403, `OMB-Profile naming another profile got HTTP ${other.status}, expected 403`);
      const same = await rawRpc(ctx.endpoint, created.token, "tools/list", {}, { headers: { [PROFILE_HEADER]: name.toUpperCase() } });
      check(same.status === 200, `OMB-Profile naming the token's own profile got HTTP ${same.status}, expected 200`);
    },
  },
];

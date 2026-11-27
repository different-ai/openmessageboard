/** core: discovery, authentication, MCP surface, identity, invites and access rules. */
import { randomBytes } from "node:crypto";
import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS, MCP_PROTOCOL_VERSION, ServerInfo, SPEC_VERSION, TOOL_NAMES } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { HUMANS, type HumanName, type PrincipalName } from "../identities.ts";
import { httpRequest, rawRpc, rpcErrorCode } from "../http.ts";
import { McpSession } from "../mcp.ts";
import { entryByRef, schemaShape, toJsonSchema } from "../schemagen/build.ts";
import { sleep } from "../util.ts";
import { assertNoLeak, mayaOnOwnerBoard, ownerBoard, quotaReaderOnOwnerBoard, reasonOf, sharedThread } from "./helpers.ts";

const randomToken = () => randomBytes(16).toString("base64url");

/** Humans (other than `exclude`) without an active membership on `boardId`. */
async function nonMembers(ctx: Ctx, boardId: string, candidates: HumanName[]): Promise<HumanName[]> {
  const out: HumanName[] = [];
  for (const c of candidates) if (!(await ctx.isMember(c, boardId))) out.push(c);
  return out;
}

export const coreAccessCases: CaseDef[] = [
  {
    id: "core.discovery",
    profile: "core",
    title: "GET /.well-known/openmessageboard returns a valid ServerInfo without authentication",
    covers: ["R00-03", "R00-04", "R00-06", "R00-07", "R07-01"],
    async run(ctx) {
      const res = await httpRequest(`${ctx.url}/.well-known/openmessageboard`);
      check(res.status === 200, `expected HTTP 200, got ${res.status}`);
      const parsed = ServerInfo.safeParse(res.json);
      check(parsed.success, `not a valid ServerInfo: ${parsed.error?.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const info = parsed.data;
      check(info.spec_version === SPEC_VERSION, `spec_version is "${info.spec_version}", expected "${SPEC_VERSION}"`);
      check(info.profiles.includes("core"), 'profiles must include "core"');
      for (const key of Object.keys(DEFAULT_LIMITS)) check(typeof info.limits[key] === "number", `limits.${key} is missing (README §Discovery)`);
      for (const key of Object.keys(DEFAULT_RATE_LIMITS)) check(typeof info.rate_limits[key] === "number", `rate_limits.${key} is missing (README §Discovery)`);
      for (const f of ["mcp_endpoint", "issuer", "web_url"] as const) {
        check(/^https?:\/\//.test(info[f]), `${f} must be an absolute URL, got "${info[f]}"`);
      }
      if (res.headers.get("access-control-allow-origin") !== "*") ctx.note("Access-Control-Allow-Origin: * is recommended on the discovery document");
      await ctx.discovery();
      ctx.note(`profiles: ${info.profiles.join(", ")}; implementation ${info.implementation.name} ${info.implementation.version}`);
    },
  },
  {
    id: "core.unauthenticated",
    profile: "core",
    title: "The MCP endpoint answers 401 with RFC 9728 resource metadata to requests without a valid token",
    covers: ["R01-08", "R01-09", "R01-10"],
    async run(ctx) {
      await ctx.discovery();
      const anon = await rawRpc(ctx.endpoint, null, "tools/list", {});
      check(anon.status === 401, `request without a token returned HTTP ${anon.status}, expected 401`);
      const bad = await rawRpc(ctx.endpoint, "not-a-real-token-" + randomToken(), "tools/list", {});
      check(bad.status === 401, `request with an invalid token returned HTTP ${bad.status}, expected 401`);
      const res = await httpRequest(ctx.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      const www = res.headers.get("www-authenticate") ?? "";
      check(/^Bearer\b/i.test(www), `WWW-Authenticate must use the Bearer scheme, got "${www}"`);
      const m = /resource_metadata="([^"]+)"/.exec(www);
      check(m, `WWW-Authenticate must carry resource_metadata="<url>" (RFC 9728 §5.1), got "${www}"`);
      const meta = await httpRequest(m[1]!);
      check(meta.status === 200, `resource metadata ${m[1]} returned HTTP ${meta.status}`);
      const doc = meta.json as { resource?: unknown; authorization_servers?: unknown };
      check(typeof doc?.resource === "string", "resource metadata needs a resource");
      check(Array.isArray(doc.authorization_servers) && doc.authorization_servers.length > 0, "resource metadata needs authorization_servers");
    },
  },
  {
    id: "core.oauth-metadata",
    profile: "core",
    title: "Authorization server metadata advertises PKCE S256, CIMD and iss in authorization responses",
    covers: ["R01-11", "R01-18"],
    async run(ctx) {
      const info = await ctx.discovery();
      const issuer = new URL(info.issuer);
      const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/+$/, "");
      const url = `${issuer.origin}/.well-known/oauth-authorization-server${path}`;
      const res = await httpRequest(url);
      check(res.status === 200, `${url} returned HTTP ${res.status}`);
      const md = (res.json ?? {}) as Record<string, unknown>;
      const strip = (s: unknown) => String(s ?? "").replace(/\/+$/, "");
      check(strip(md.issuer) === strip(info.issuer), `metadata issuer "${String(md.issuer)}" differs from ServerInfo.issuer "${info.issuer}"`);
      for (const f of ["authorization_endpoint", "token_endpoint"]) check(typeof md[f] === "string", `${f} is missing`);
      const list = (k: string) => (Array.isArray(md[k]) ? (md[k] as unknown[]) : []);
      check(list("response_types_supported").includes("code"), 'response_types_supported must include "code"');
      check(list("code_challenge_methods_supported").includes("S256"), 'code_challenge_methods_supported must include "S256"');
      check(!list("code_challenge_methods_supported").includes("plain"), 'code_challenge_methods_supported must not include "plain"');
      check(md.client_id_metadata_document_supported === true, "client_id_metadata_document_supported must be true (CIMD)");
      check(md.authorization_response_iss_parameter_supported === true, "authorization_response_iss_parameter_supported must be true (RFC 9207)");
      if (list("grant_types_supported").length && !list("grant_types_supported").includes("authorization_code")) throw new Failure("grant_types_supported must include authorization_code");
      if (typeof md.registration_endpoint !== "string") ctx.note("no registration_endpoint: Dynamic Client Registration fallback not offered (SHOULD)");
    },
  },
  {
    id: "core.mcp-connect",
    profile: "core",
    title: `Every identity connects with bearer tokens and negotiates MCP ${MCP_PROTOCOL_VERSION}`,
    covers: ["R01-06", "R06-01"],
    async run(ctx) {
      const names: PrincipalName[] = [...HUMANS, "agent"];
      const legacy: string[] = [];
      for (const n of names) {
        const s = await ctx.session(n);
        if (!s.modern) legacy.push(`${n} → ${s.protocolVersion ?? "none"}`);
      }
      check(legacy.length === 0, `server did not negotiate ${MCP_PROTOCOL_VERSION} for: ${legacy.join(", ")}`);
      const owner = await ctx.session("owner");
      const d = await owner.rpc("server/discover");
      check(d.result, `server/discover failed: ${JSON.stringify(d.error)}`);
      const caps = (d.result.capabilities ?? {}) as Record<string, unknown>;
      check(caps.tools && typeof caps.tools === "object", "server/discover capabilities must include tools");
      check(caps.resources && typeof caps.resources === "object", "server/discover capabilities must include resources");
    },
  },
  {
    id: "core.tools-list",
    profile: "core",
    title: "tools/list returns the protocol tools in order with matching input and output schemas",
    covers: ["R06-02", "R06-06", "R06-07"],
    async run(ctx) {
      const owner = await ctx.session("owner");
      const r = await owner.rpc("tools/list");
      check(r.result, `tools/list failed: ${JSON.stringify(r.error)}`);
      if (typeof r.result.ttlMs !== "number" || r.result.cacheScope === undefined) ctx.note("tools/list result lacks ttlMs/cacheScope (CacheableResult, MCP 2026-07-28)");
      const tools = (r.result.tools ?? []) as { name: string; inputSchema?: unknown; outputSchema?: unknown }[];
      const names = tools.map((t) => t.name);
      const known = names.filter((n) => (TOOL_NAMES as string[]).includes(n));
      const taskTools = ["claim_task", "renew_task", "update_task", "create_tasks", "set_labels"];
      const automationTools = ["schedule_post", "list_schedules", "cancel_schedule", "create_watcher", "list_watchers", "delete_watcher"];
      const expected = TOOL_NAMES.filter(
        (n) => known.includes(n) || ((!taskTools.includes(n) || ctx.claims("tasks")) && (!automationTools.includes(n) || ctx.claims("automation"))),
      );
      const missing = expected.filter((n) => !names.includes(n));
      check(missing.length === 0, `tools/list is missing: ${missing.join(", ")}`);
      check(JSON.stringify(known) === JSON.stringify(expected), `tools are not in protocol order.\n  got:      ${known.join(", ")}\n  expected: ${expected.join(", ")}`);
      const extras = names.filter((n) => !(TOOL_NAMES as string[]).includes(n));
      if (extras.length) ctx.note(`additional tools not in the spec: ${extras.join(", ")}`);
      const mismatches: string[] = [];
      for (const t of tools) {
        if (!(TOOL_NAMES as string[]).includes(t.name)) continue;
        for (const part of ["input", "output"] as const) {
          const entry = entryByRef(`tools/${t.name}.${part}`)!;
          const ours = schemaShape(toJsonSchema(entry));
          const theirs = schemaShape(part === "input" ? t.inputSchema : t.outputSchema);
          if (part === "output" && !t.outputSchema) {
            if (ours.properties.length) mismatches.push(`${t.name}: no outputSchema`);
            else ctx.note(`${t.name}: no outputSchema (RECOMMENDED for union outputs, 06 §Tools)`);
            continue;
          }
          if (!ours.properties.length) continue; // union outputs (get_changes, wait_for_activity)
          if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
            mismatches.push(`${t.name} ${part}: properties [${theirs.properties}] required [${theirs.required}] vs spec [${ours.properties}] required [${ours.required}]`);
          }
        }
      }
      check(mismatches.length === 0, `schemas differ from schemas/v0.1/tools:\n  ${mismatches.join("\n  ")}`);
    },
  },
  {
    id: "core.personal-board-once",
    profile: "core",
    title: "Ten parallel whoami calls for one person create exactly one personal board",
    covers: ["R02-03"],
    async run(ctx) {
      await ctx.discovery();
      const started = ctx.serverNow();
      const sessions = await Promise.all(Array.from({ length: 10 }, () => McpSession.connect("owner*", ctx.endpoint, ctx.token("owner"))));
      try {
        const results = await Promise.all(sessions.map((s) => s.ok("whoami", {})));
        const ids = new Set(results.map((w) => w.owned_board?.id));
        check(!ids.has(undefined), "whoami returned owned_board: null for a human");
        check(ids.size === 1, `parallel whoami calls returned ${ids.size} different boards: ${[...ids].join(", ")}`);
        const w = results[0]!;
        check(w.owned_board!.is_personal, "owned_board.is_personal must be true");
        check(w.owned_board!.my_role === "owner", "owned_board.my_role must be owner");
        const after = await (await ctx.session("owner")).ok("whoami", {});
        const owned = after.memberships.filter((m) => m.is_owner);
        check(owned.length === 1, `owner holds ${owned.length} owned memberships after parallel whoami, expected 1`);
        check(after.owned_board?.id === w.owned_board!.id, "a later whoami returns the same board");
        if (Date.parse(w.owned_board!.created_at) < started - 10_000) ctx.note("the board existed before this run, so this checked repeat calls, not the very first call");
      } finally {
        await Promise.all(sessions.map((s) => s.close()));
      }
    },
  },
  {
    id: "core.whoami",
    profile: "core",
    title: "whoami describes humans and agents correctly",
    covers: ["R01-03", "R01-31", "R02-02"],
    async run(ctx) {
      for (const n of HUMANS) {
        const { whoami: w } = await ctx.me(n);
        check(w.principal.kind === "human", `${n}: principal.kind is ${w.principal.kind}`);
        check((w.principal.email ?? "").toLowerCase() === ctx.email(n).toLowerCase(), `${n}: principal.email is ${w.principal.email}, expected ${ctx.email(n)}`);
        check(w.owned_board && w.owned_board.owner.id === w.principal.id, `${n}: owned_board must be owned by the caller`);
        check(w.owned_board.url.endsWith(`/b/${w.owned_board.id}`), `${n}: board url must end with /b/{board_id}`);
        check(w.server.spec_version === SPEC_VERSION, `${n}: server.spec_version mismatch`);
        const plans = w.server.plans ?? [];
        if (plans.length) {
          check(w.principal.plan && plans.some((pl) => pl.id === w.principal.plan), `${n}: a server with plans reports whoami.principal.plan (one of ${plans.map((pl) => pl.id).join(", ")})`);
          for (const key of Object.keys(DEFAULT_LIMITS)) check(typeof w.principal.limits?.[key] === "number", `${n}: whoami.principal.limits.${key} is missing (07 §Plans)`);
        }
      }
      if ((await ctx.me("owner")).whoami.server.plans?.length) ctx.note(`plans: ${(await ctx.me("owner")).whoami.server.plans!.map((pl) => pl.id).join(", ")}; test identities are on ${(await ctx.me("owner")).whoami.principal.plan}`);
      const agent = await ctx.me("agent");
      const maya = await ctx.me("maya");
      const p = agent.whoami.principal;
      check(p.kind === "agent", `agent: principal.kind is ${p.kind}`);
      check(p.owner?.id === maya.id, "agent: principal.owner must be maya");
      check(agent.whoami.owned_board === null, "agent: owned_board must be null (agents never own boards)");
      check(p.email === null, "agent: email must be null");
      if (p.display_name !== ctx.opts.identities.principals.agent.display_name) ctx.note(`agent display_name is "${p.display_name}", identities file says "${ctx.opts.identities.principals.agent.display_name}"`);
      for (const m of agent.whoami.memberships) check(m.role !== "owner", "agent memberships never have the owner role");
      if (maya.whoami.principal.plan) check(p.plan === maya.whoami.principal.plan, "agents inherit their owner's plan (07 §Plans)");
      if (agent.whoami.memberships.length === 0) ctx.note("agent sees no boards before being added (as expected)");
      else ctx.note(`agent is on ${agent.whoami.memberships.length} board(s) its owner added it to`);
    },
  },
  {
    id: "core.agent-rules",
    profile: "core",
    title: "Agents cannot redeem or create invites",
    covers: ["R01-30", "R02-19"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const agent = await ctx.session("agent");
      const { invite } = await owner.ok("create_invite", { board_id: board, audience: "link", role: "reader" });
      const e1 = await agent.fails("redeem_invite", { invite: invite.url! }, "invite_not_eligible");
      check(reasonOf(e1) === "agent_not_allowed", `details.reason is ${reasonOf(e1)}, expected agent_not_allowed`);
      assertNoLeak(e1, [board, (await ctx.me("owner")).whoami.owned_board?.name], "agent redeem");
      const e2 = await agent.fails("redeem_invite", { invite: randomToken() }, ["invite_not_eligible", "not_found"]);
      if (e2.code === "invite_not_eligible") check(reasonOf(e2) === "agent_not_allowed", "invite_not_eligible for an agent carries reason agent_not_allowed");
      const mayaBoard = await ctx.boardOf("maya");
      const onMayaBoard = await ctx.isMember("agent", mayaBoard);
      const expected = onMayaBoard ? "forbidden" : "not_found";
      await agent.fails("create_invite", { board_id: mayaBoard, audience: "link", role: "reader" }, expected);
      await agent.fails("get_usage", { board_id: mayaBoard }, expected);
    },
  },
  {
    id: "core.invite-email",
    profile: "core",
    title: "Email invites admit only the invited address; others fail with invite_not_eligible and see nothing",
    covers: ["R02-23", "R02-28"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const boardName = (await ctx.me("owner")).whoami.owned_board?.name;
      const multi = await owner.ok("create_invite", { board_id: board, audience: "email", value: ctx.email("maya"), role: "contributor", max_uses: 3 });
      check(multi.invite.max_uses === 1, `an email invite created with max_uses 3 reports max_uses ${multi.invite.max_uses}; email invites are single-use (stored as 1)`);
      await owner.fails("create_invite", { board_id: board, audience: "link", value: ctx.email("maya"), role: "reader" }, "invalid_argument");
      const { invite } = await owner.ok("create_invite", { board_id: board, audience: "email", value: ctx.email("maya"), role: "contributor" });
      check(invite.url && invite.url.includes("/i/"), `create_invite must return the invite URL ({base}/i/{token}), got ${invite.url}`);
      check(invite.audience === "email" && invite.role === "contributor", "invite echoes audience and role");
      check(invite.max_uses === 1, `email invite reports max_uses ${invite.max_uses}; email invites are single-use (stored as 1)`);
      for (const n of ["outsider", "lookalike"] as const) {
        if (await ctx.isMember(n, board)) ctx.skip(`${n} is already a member of the owner's board; use a fresh server`);
        const e = await (await ctx.session(n)).fails("redeem_invite", { invite: invite.url }, "invite_not_eligible");
        check(reasonOf(e) === "email_mismatch", `${n}: details.reason is ${reasonOf(e)}, expected email_mismatch`);
        assertNoLeak(e, [board, boardName], `${n} redeem`);
      }
      const already = await ctx.isMember("maya", board);
      const maya = await ctx.session("maya");
      const joined = await maya.ok("redeem_invite", { invite: invite.url });
      check(joined.board.id === board, "redeem_invite returns the invited board");
      if (already) ctx.note("maya was already a member, so this checked the no-change path");
      else check(joined.board.my_role === "contributor", `maya joined as ${joined.board.my_role}, expected contributor`);
      const again = await maya.ok("redeem_invite", { invite: invite.url });
      check(again.board.id === board, "redeeming again as a member returns the board with no change");
    },
  },
  {
    id: "core.invite-domain",
    profile: "core",
    title: "Domain invites match the exact domain; lookalike, subdomain and other domains fail",
    covers: ["R02-14", "R02-15"],
    async run(ctx) {
      const board = await ownerBoard(ctx);
      const owner = await ctx.session("owner");
      const boardName = (await ctx.me("owner")).whoami.owned_board?.name;
      const domain = ctx.email("owner").split("@")[1]!;
      await owner.fails("create_invite", { board_id: board, audience: "domain", value: "gmail.com", role: "reader" }, "invalid_argument");
      await owner.fails("create_invite", { board_id: board, audience: "domain", role: "reader" }, "invalid_argument");
      const { invite } = await owner.ok("create_invite", { board_id: board, audience: "domain", value: domain, role: "reader" });
      check(invite.url, "create_invite returns the invite URL");
      check(invite.join_by !== null, "link and domain invites default to a Join by (7 days)");
      for (const n of ["lookalike", "subdomain", "outsider"] as const) {
        if (await ctx.isMember(n, board)) ctx.skip(`${n} is already a member of the owner's board; use a fresh server`);
        const e = await (await ctx.session(n)).fails("redeem_invite", { invite: invite.url }, "invite_not_eligible");
        check(reasonOf(e) === "domain_mismatch", `${n} (${ctx.email(n)}): details.reason is ${reasonOf(e)}, expected domain_mismatch`);
        assertNoLeak(e, [board, boardName], `${n} redeem`);
      }
      const quota = await ctx.session("quota");
      const already = await ctx.isMember("quota", board);
      const joined = await quota.ok("redeem_invite", { invite: invite.url });
      check(joined.board.id === board, "the intended domain member joins");
      if (!already) check(joined.board.my_role === "reader", `quota joined as ${joined.board.my_role}, expected reader`);
      else ctx.note("quota was already a member (no-change path)");
    },
  },
  {
    id: "core.invite-expired",
    profile: "core",
    title: "An invite past its Join by fails with invite_expired",
    covers: ["R02-21"],
    async run(ctx) {
      const mayaBoard = await ctx.boardOf("maya");
      const maya = await ctx.session("maya");
      const [who] = await nonMembers(ctx, mayaBoard, ["outsider", "lookalike", "owner", "quota"]);
      if (!who) return ctx.skip("every candidate is already a member of maya's board; use a fresh server");
      const joinBy = ctx.serverNow() + 4000;
      const { invite } = await maya.ok("create_invite", { board_id: mayaBoard, audience: "link", role: "reader", join_by: new Date(joinBy).toISOString() });
      check(invite.join_by, "invite echoes join_by");
      while (ctx.serverNow() < joinBy + 1500) await sleep(250);
      const e = await (await ctx.session(who)).fails("redeem_invite", { invite: invite.url! }, "invite_expired");
      check(reasonOf(e) === "join_by_passed", `details.reason is ${reasonOf(e)}, expected join_by_passed`);
      assertNoLeak(e, [mayaBoard], "expired redeem");
    },
  },
  {
    id: "core.invite-max-uses",
    profile: "core",
    title: "An invite with max_uses stops after its last use",
    covers: ["R02-22"],
    async run(ctx) {
      const mayaBoard = await ctx.boardOf("maya");
      const maya = await ctx.session("maya");
      const candidates = await nonMembers(ctx, mayaBoard, ["outsider", "lookalike", "owner", "quota"]);
      if (candidates.length < 2) ctx.skip("needs two humans who are not members of maya's board; use a fresh server");
      const [first, second] = candidates as [HumanName, HumanName];
      const { invite } = await maya.ok("create_invite", { board_id: mayaBoard, audience: "link", role: "reader", max_uses: 1 });
      check(invite.max_uses === 1, "invite echoes max_uses");
      const ok = await (await ctx.session(first)).ok("redeem_invite", { invite: invite.url! });
      check(ok.board.id === mayaBoard, "first redemption joins the board");
      const e = await (await ctx.session(second)).fails("redeem_invite", { invite: invite.url! }, "invite_expired");
      check(reasonOf(e) === "used_up", `details.reason is ${reasonOf(e)}, expected used_up`);
    },
  },
  {
    id: "core.invite-unknown",
    profile: "core",
    title: "An unknown invite token returns not_found",
    covers: ["R02-18"],
    async run(ctx) {
      await (await ctx.session("outsider")).fails("redeem_invite", { invite: randomToken() }, "not_found");
      await (await ctx.session("outsider")).fails("redeem_invite", { invite: `${await ctx.resourceBase()}/i/${randomToken()}` }, "not_found");
    },
  },
  {
    id: "core.invite-disabled",
    profile: "core",
    title: "A disabled invite fails with invite_disabled",
    covers: [],
    placeholder: true,
    async run(ctx) {
      ctx.skip("disabling an invite is a web-only owner action in v0.1; there is no MCP path to set it up");
    },
  },
  {
    id: "core.non-member-not-found",
    profile: "core",
    title: "Non-members get not_found for board objects, indistinguishable from unknown IDs",
    covers: ["R02-36"],
    async run(ctx) {
      const t = await sharedThread(ctx);
      if (await ctx.isMember("outsider", t.boardId)) ctx.skip("outsider is a member of the owner's board; use a fresh server");
      const outsider = await ctx.session("outsider");
      const boardName = (await ctx.me("owner")).whoami.owned_board?.name;
      const secrets = [t.title, boardName];
      const attempts: [string, Record<string, unknown>][] = [
        ["get_thread", { thread_id: t.threadId }],
        ["get_thread", { thread_id: "t_doesnotexist000" }],
        ["list_threads", { board_id: t.boardId }],
        ["list_members", { board_id: t.boardId }],
        ["get_changes", { board_id: t.boardId }],
        ["search_messages", { board_id: t.boardId, query: "conformance" }],
        ["start_thread", { board_id: t.boardId, title: "x", body: "x", idempotency_key: `nm-${ctx.runId}` }],
        ["reply", { thread_id: t.threadId, body: "x", idempotency_key: `nm-${ctx.runId}` }],
        ["set_follow", { thread_id: t.threadId, following: true }],
        ["delete_message", { message_id: t.rootId }],
        ["create_invite", { board_id: t.boardId, audience: "link", role: "reader" }],
        ["get_usage", { board_id: t.boardId }],
      ];
      for (const [tool, args] of attempts) {
        const e = await outsider.fails(tool, args, "not_found");
        assertNoLeak(e, secrets, `outsider ${tool}`);
      }
      const base = await ctx.resourceBase();
      for (const uri of [`${base}/b/${t.boardId}`, `${base}/b/${t.boardId}/t/${t.threadId}`, `${base}/b/b_doesnotexist000`]) {
        const r = await outsider.rpc("resources/read", { uri });
        check(r.error, `resources/read ${uri} by a non-member succeeded`);
        check(r.error.code === -32602, `resources/read ${uri}: JSON-RPC code ${r.error.code}, expected -32602`);
        const code = rpcErrorCode(r.error);
        check(code === undefined || code === "not_found", `resources/read ${uri}: data.code ${code}, expected not_found`);
        assertNoLeak(r.error, secrets, `resources/read ${uri}`);
      }
    },
  },
  {
    id: "core.reader-cannot-post",
    profile: "core",
    title: "A reader can read and follow but cannot post (forbidden)",
    covers: ["R02-06", "R02-07", "R02-08"],
    async run(ctx) {
      const board = await quotaReaderOnOwnerBoard(ctx);
      const t = await sharedThread(ctx);
      const reader = await ctx.session("quota");
      await reader.ok("list_threads", { board_id: board });
      await reader.ok("get_thread", { thread_id: t.threadId });
      await reader.ok("set_follow", { thread_id: t.threadId, following: true });
      await reader.fails("start_thread", { board_id: board, title: "reader post", body: "should fail", idempotency_key: `rd-${ctx.runId}-1` }, "forbidden");
      await reader.fails("reply", { thread_id: t.threadId, body: "should fail", idempotency_key: `rd-${ctx.runId}-2` }, "forbidden");
      await reader.fails("create_invite", { board_id: board, audience: "link", role: "reader" }, "forbidden");
      await reader.fails("get_usage", { board_id: board }, "forbidden");
    },
  },
  {
    id: "core.maya-joins",
    profile: "core",
    title: "Setup: maya is a contributor on the owner's board",
    covers: ["R02-25"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const w = await (await ctx.session("maya")).ok("whoami", {});
      const m = w.memberships.find((x) => x.board_id === board);
      check(m, "maya's memberships include the owner's board");
      check(m.role === "contributor", `maya's role is ${m.role}, expected contributor`);
    },
  },
];

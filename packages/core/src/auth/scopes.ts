import { ROLE_RANK, TOKEN_PERMISSIONS, type Role, type TokenPermission, type TokenScope, type ToolName } from "@openmessageboard/protocol";
import { forbidden, invalid } from "../errors.js";

/**
 * Scoped tokens: a token can be limited to some boards, to reading, and to one profile.
 * These helpers are pure so access checks, the MCP server and the web API share them.
 * `can` caps the role on each board and masks per-channel permissions (domain/grants.ts); `manage` is never allowed.
 */
type Scoped = { scope?: TokenScope | null | undefined };

export const ALL_PERMISSIONS: TokenPermission[] = [...TOKEN_PERMISSIONS];

/** Accepts `["read"]` or all four permissions (any order). */
export function normalizeCan(can: readonly string[] | undefined): TokenPermission[] {
  if (!can) return [...ALL_PERMISSIONS];
  const set = new Set(can);
  if (set.size === 1 && set.has("read")) return ["read"];
  if (set.size === ALL_PERMISSIONS.length && ALL_PERMISSIONS.every((p) => set.has(p))) return [...ALL_PERMISSIONS];
  throw invalid('can is ["read"], or ["read", "post", "react", "label"]');
}

/** The most a scoped token acts as on any board. */
export function roleCap(scope: TokenScope): Role {
  return scope.can.some((p) => p !== "read") ? "contributor" : "reader";
}

/** The role after the token's cap. */
export function cappedRole(actor: Scoped, role: Role): Role {
  if (!actor.scope) return role;
  const cap = roleCap(actor.scope);
  return ROLE_RANK[role] > ROLE_RANK[cap] ? cap : role;
}

export function boardInScope(actor: Scoped, boardId: string): boolean {
  return !actor.scope?.boards || actor.scope.boards.includes(boardId);
}

export type ScopeNeed = TokenPermission | "manage";

/** Refuses a scoped caller that lacks `need`. `manage` (invites, members, agents, tokens, webhooks) is never allowed. */
export function requireScope(actor: Scoped, need: ScopeNeed): void {
  const scope = actor.scope;
  if (!scope) return;
  if (need === "manage") throw forbidden("A scoped token can't do that; use your own sign-in or an unscoped token");
  if (!scope.can.includes(need)) throw forbidden(`This token is limited to ${scope.can.join(", ")}`);
}

/** What each tool needs from a scoped token. A new tool must be classified here (the map is exhaustive). */
export const TOOL_SCOPE: Record<ToolName, ScopeNeed> = {
  whoami: "read",
  list_threads: "read",
  get_thread: "read",
  start_thread: "post",
  reply: "post",
  delete_message: "post",
  set_follow: "read",
  // Like a follow: a preference about the caller's own inbox, so a read-only token may set it.
  set_subscription: "read",
  list_subscriptions: "read",
  get_inbox: "read",
  mark_read: "read",
  get_changes: "read",
  wait_for_activity: "read",
  search_messages: "read",
  list_members: "read",
  claim_task: "post",
  renew_task: "post",
  update_task: "post",
  create_tasks: "post",
  set_labels: "label",
  create_invite: "manage",
  redeem_invite: "manage",
  get_usage: "manage",
  list_actors: "read",
  create_scoped_token: "manage",
  list_channels: "read",
  // A private channel creates grants, which needs "manage" (checked in domain/channels.ts).
  create_channel: "post",
  create_board: "manage",
  list_grants: "read",
  create_grant: "manage",
  update_grant: "manage",
  revoke_grant: "manage",
  explain_access: "read",
  edit_message: "post",
  react: "react",
  label_message: "label",
  upload_attachment: "post",
  get_attachment: "read",
  list_schemas: "read",
  get_schema: "read",
  register_schema: "manage",
  read_messages: "read",
  schedule_post: "post",
  list_schedules: "read",
  cancel_schedule: "post",
  // Watchers are board automation that sends board content to an outside URL: never from a scoped token.
  create_watcher: "manage",
  list_watchers: "manage",
  delete_watcher: "manage",
};

/** MCP methods other than tools: Events polling reads; webhook subscriptions are managed. */
export const METHOD_SCOPE: Record<string, ScopeNeed> = {
  "events/list": "read",
  "events/poll": "read",
  "events/stream": "read",
  "events/subscribe": "manage",
  "events/unsubscribe": "manage",
};

/**
 * Web API routes a scoped token may call. Anything not listed is refused (fail closed); that includes the email
 * sign-in routes (`/api/sign-in/*`), which are for browsers without a credential.
 */
const API_SCOPE: [method: string, path: RegExp, need: TokenPermission][] = [
  ["GET", /^\/api\/(session|me)$/, "read"],
  ["GET", /^\/api\/boards\/[^/]+$/, "read"],
  ["GET", /^\/api\/boards\/[^/]+\/(threads|changes|stream|search|members|actors|channels|access|messages|schedules)$/, "read"],
  ["POST", /^\/api\/boards\/[^/]+\/channels$/, "post"],
  ["GET", /^\/api\/threads\/[^/]+\/schedules$/, "read"],
  ["POST", /^\/api\/(boards|threads)\/[^/]+\/schedules$/, "post"],
  ["DELETE", /^\/api\/schedules\/[^/]+$/, "post"],
  ["POST", /^\/api\/boards\/[^/]+\/threads$/, "post"],
  ["POST", /^\/api\/boards\/[^/]+\/tasks(\/claim)?$/, "post"],
  ["GET", /^\/api\/threads\/[^/]+$/, "read"],
  ["POST", /^\/api\/threads\/[^/]+\/messages$/, "post"],
  ["POST", /^\/api\/threads\/[^/]+\/task(\/renew)?$/, "post"],
  ["POST", /^\/api\/threads\/[^/]+\/labels$/, "label"],
  ["PUT", /^\/api\/threads\/[^/]+\/follow$/, "read"],
  ["DELETE", /^\/api\/messages\/[^/]+$/, "post"],
  ["PATCH", /^\/api\/messages\/[^/]+$/, "post"],
  ["POST", /^\/api\/messages\/[^/]+\/reactions$/, "react"],
  ["POST", /^\/api\/messages\/[^/]+\/labels$/, "label"],
  ["POST", /^\/api\/boards\/[^/]+\/attachments$/, "post"],
  ["GET", /^\/api\/attachments\/[^/]+$/, "read"],
  ["GET", /^\/api\/boards\/[^/]+\/schemas(\/[^/]+)?$/, "read"],
  ["GET", /^\/api\/inbox(\/stream)?$/, "read"],
  ["POST", /^\/api\/inbox\/read$/, "read"],
];

export function apiScopeNeed(method: string, path: string): ScopeNeed {
  const m = method === "HEAD" ? "GET" : method;
  for (const [verb, re, need] of API_SCOPE) if (verb === m && re.test(path)) return need;
  return "manage";
}

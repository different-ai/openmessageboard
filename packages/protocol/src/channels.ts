import { z } from "zod";
import { ROLES } from "./constants.js";
import { Board, PrincipalRef } from "./entities.js";

/**
 * Channels, named boards and per-channel access (grants). Kept in its own module so the
 * rest of the tool surface can grow without touching this file.
 */

/** A thread's channel when none is given, and the channel existing threads moved to. */
export const DEFAULT_CHANNEL = "general";
export const MAX_CHANNEL_SEGMENT = 40;
export const MAX_CHANNEL_DEPTH = 6;
export const MAX_CHANNEL_CHARS = 120;
export const MAX_GRANTS_PER_BOARD = 100;
export const MAX_GRANT_PRINCIPALS = 50;
export const MAX_GRANT_PATTERNS = 20;

const SEGMENT = `[a-z0-9_-]{1,${MAX_CHANNEL_SEGMENT}}`;
const PATH = `${SEGMENT}(?:/${SEGMENT}){0,${MAX_CHANNEL_DEPTH - 1}}`;
/** A channel path: lowercase segments of letters, digits, `-` and `_`, joined by `/`. */
export const CHANNEL_PATH_PATTERN = new RegExp(`^${PATH}$`);
/** A channel filter: a path, or a path with a trailing slash for its subtree. */
export const CHANNEL_FILTER_PATTERN = new RegExp(`^${PATH}/?$`);
/** A grant pattern: an exact channel, a subtree (`security/`), or `*` for every channel. */
export const GRANT_PATTERN_PATTERN = new RegExp(`^(?:\\*|${PATH}/?)$`);

const pathHint = `lowercase segments of letters, digits, '-' and '_' joined by '/', up to ${MAX_CHANNEL_DEPTH} segments of ${MAX_CHANNEL_SEGMENT} characters`;

export const ChannelPath = z
  .string()
  .max(MAX_CHANNEL_CHARS)
  .regex(CHANNEL_PATH_PATTERN, `Channel paths are ${pathHint}`)
  .describe(`Channel path such as dev or www/production (${pathHint})`);

export const ChannelFilter = z
  .string()
  .max(MAX_CHANNEL_CHARS + 1)
  .regex(CHANNEL_FILTER_PATTERN, `Channel filters are a channel path, or a path ending in '/' for the channel and everything under it`)
  .describe("A channel, or a path ending in '/' for that channel and every channel under it (www/ matches www, www/production and www/preview)");

export const GrantPattern = z
  .string()
  .max(MAX_CHANNEL_CHARS + 1)
  .regex(GRANT_PATTERN_PATTERN, "Grant patterns are '*', a channel path, or a path ending in '/' for its subtree")
  .describe("'*' for every channel, an exact channel, or a subtree ending in '/' (security/ covers security and everything under it)");

/** The same patterns, for channel subscriptions (03 §Subscriptions). */
export const SubscriptionPattern = z
  .string()
  .max(MAX_CHANNEL_CHARS + 1)
  .regex(GRANT_PATTERN_PATTERN, "A pattern is '*', a channel path, or a path ending in '/' for its subtree")
  .describe("'*' for every channel, an exact channel, or a subtree ending in '/' (support/ covers support and everything under it)");

export const PERMISSIONS = ["read", "post", "react", "label", "manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const Permission = z.enum(PERMISSIONS);

export const GRANT_GROUPS = ["readers", "contributors", "everyone"] as const;
export type GrantGroup = (typeof GRANT_GROUPS)[number];

/**
 * Who a grant names: one member (people's grants also reach the agents that act for them), a role group, every
 * member, or the public: everyone signed in on the server who is not a member (11 §Public access). A public grant
 * gives `read` or nothing, and only the board's owner makes one.
 */
export const GrantPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), principal_id: z.string().min(1).describe("Member principal ID") }),
  z.object({ kind: z.literal("readers").describe("Every member whose board role is reader") }),
  z.object({ kind: z.literal("contributors").describe("Every member whose board role is contributor") }),
  z.object({ kind: z.literal("everyone").describe("Every member of the board, the owner included") }),
  z.object({ kind: z.literal("public").describe("Everyone signed in on the server who is not a member; read only, alone in its grant") }),
]);
export type GrantPrincipal = z.infer<typeof GrantPrincipal>;

/** What a grant gives, by pattern: a list of permissions, `all` or `none`. */
export const GrantCanInput = z
  .record(GrantPattern, z.union([z.enum(["all", "none"]), z.array(Permission)]))
  .describe(`Pattern → 'all', 'none' or a list of ${PERMISSIONS.join(", ")} (up to ${MAX_GRANT_PATTERNS} patterns)`);
export type GrantCanInput = z.infer<typeof GrantCanInput>;

/** What a grant gives, normalized: pattern → permissions (an empty list closes the pattern). */
export const GrantCan = z.record(GrantPattern, z.array(Permission));
export type GrantCan = z.infer<typeof GrantCan>;

const isoTime = z.string().describe("RFC 3339 UTC timestamp");

export const Grant = z.object({
  id: z.string(),
  board_id: z.string(),
  principals: z.array(GrantPrincipal),
  can: GrantCan,
  created_by: PrincipalRef,
  created_at: isoTime,
  updated_at: isoTime,
});
export type Grant = z.infer<typeof Grant>;

export const Channel = z.object({
  board_id: z.string(),
  path: z.string(),
  thread_count: z.number().int(),
  last_activity_at: isoTime.nullable().describe("Latest activity in any of its threads; null for an empty channel"),
  private: z.boolean().describe("True when a member with no grant of their own can't read it"),
  public: z.boolean().default(false).describe("True when a public grant lets people who are not members read it"),
  my_permissions: z.array(Permission).describe("What the caller can do in this channel"),
  created_at: isoTime,
});
export type Channel = z.infer<typeof Channel>;

export const AccessExplanation = z.object({
  board_id: z.string(),
  channel: z.string(),
  principal: PrincipalRef,
  role: z.enum(ROLES).nullable().describe("null for someone reading through a public grant, who is not a member"),
  can: z.array(Permission).describe("What the principal can do in the channel"),
  pattern: z.string().nullable().describe("The grant pattern that decided; null when no grant applies and the role's defaults hold"),
  level: z.enum(["agent", "member", "role_group", "everyone", "public"]).nullable().describe("Which principal of the deciding grants matched"),
  grant_ids: z.array(z.string()).describe("Grants tied at the deciding pattern and level; their permissions add up"),
  granted: z.array(Permission).describe("What the deciding grants (or the role's defaults) give before caps"),
  role_cap: z.array(Permission).describe("The most the board role allows"),
  person_cap: z.array(Permission).nullable().describe("Agents: what the person they act for can do in the channel"),
});
export type AccessExplanation = z.infer<typeof AccessExplanation>;

const id = (what: string) => z.string().min(1).describe(`${what} ID`);

/**
 * The second half of an approval (06 §Tool errors): a call answered `approval_required` is repeated with
 * `approved: true` once the caller's person has agreed to it. Ignored where no approval is asked for.
 */
export const Approved = z
  .boolean()
  .optional()
  .describe("Send true only after this call was answered approval_required and the person you act for agreed to it in this conversation");

/** Tools for channels, named boards and grants. Listed after the core tools, in this order. */
export const CHANNEL_TOOLS = {
  list_channels: {
    description: "Channels on a board that you can read, with thread counts, last activity, whether each is private, and what you can do there.",
    input: z.object({ board_id: id("Board") }),
    output: z.object({ channels: z.array(Channel) }),
  },
  create_channel: {
    description:
      "Create a channel before anything posts to it (a first post also creates one). private: true closes it to everyone but you with two grants; it needs manage there and fails if the channel, a channel under it, or a grant for it already exists.",
    input: z.object({ board_id: id("Board"), path: ChannelPath, private: z.boolean().optional() }),
    output: z.object({ channel: Channel, created: z.boolean(), grants: z.array(Grant) }),
  },
  create_board: {
    description: "People: create another named board you own, up to your plan's boards_owned. Names are unique among your boards.",
    input: z.object({ name: z.string().min(1).max(80) }),
    output: z.object({ board: Board }),
  },
  list_grants: {
    description: "The board's grants that you can manage (every grant for the owner), with their IDs.",
    input: z.object({ board_id: id("Board") }),
    output: z.object({ grants: z.array(Grant) }),
  },
  create_grant: {
    description:
      "Open or narrow access per channel. The most specific pattern decides, then the closest principal (member, then role group, then everyone); grants tied there add up, and the board role caps the result. Needs manage at every pattern. A grant to the public is for the board's owner, or an agent or profile acting for the owner: an agent is first answered approval_required, asks its person, and repeats the call with approved: true.",
    input: z.object({
      board_id: id("Board"),
      principals: z.array(GrantPrincipal).min(1).max(MAX_GRANT_PRINCIPALS),
      can: GrantCanInput,
      approved: Approved,
    }),
    output: z.object({ grant: Grant }),
  },
  update_grant: {
    description:
      "Add or remove a grant's principals, or replace what it gives (can). Needs manage at its patterns. Changing a public grant follows create_grant: an agent is first answered approval_required.",
    input: z.object({
      grant_id: id("Grant"),
      add: z.array(GrantPrincipal).max(MAX_GRANT_PRINCIPALS).optional(),
      remove: z.array(GrantPrincipal).max(MAX_GRANT_PRINCIPALS).optional(),
      can: GrantCanInput.optional(),
      approved: Approved,
    }),
    output: z.object({ grant: Grant }),
  },
  revoke_grant: {
    description: "Remove a grant. What it gave stops from the next request. Needs manage at its patterns.",
    input: z.object({ grant_id: id("Grant") }),
    output: z.object({ grant_id: z.string(), revoked: z.boolean() }),
  },
  explain_access: {
    description: "Which grant decides what a member can do in a channel. Without principal_id it explains your own access; explaining someone else's needs manage at '*'.",
    input: z.object({ board_id: id("Board"), channel: ChannelPath, principal_id: z.string().optional() }),
    output: AccessExplanation,
  },
} as const;

export type ChannelToolName = keyof typeof CHANNEL_TOOLS;
export const CHANNEL_WRITE_TOOLS: readonly ChannelToolName[] = ["create_channel", "create_board", "create_grant", "update_grant", "revoke_grant"];

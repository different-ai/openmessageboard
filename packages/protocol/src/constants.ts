/** OpenMessageBoard protocol constants (spec v0.1). */
export const SPEC_VERSION = "0.1";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const EXPORT_FORMAT = "openmessageboard.export/0.1";
export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

export const ROLES = ["reader", "contributor", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { reader: 1, contributor: 2, owner: 3 };

/** `integration` principals author messages that arrive from Slack, GitHub or Linear sync. */
export const PRINCIPAL_KINDS = ["human", "agent", "integration"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const THREAD_KINDS = ["discussion", "task"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * `waiting` (a task it needs has not completed), `ready` (claimable), `claimed` (a worker holds its lease), `blocked`
 * (held for a person), and the finished states `completed`, `failed` and `canceled`.
 */
export const TASK_STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Unfinished states. The filter value `open` matches any of them. */
export const OPEN_TASK_STATES = ["waiting", "ready", "claimed", "blocked"] as const satisfies readonly TaskState[];
export const FINISHED_TASK_STATES = ["completed", "failed", "canceled"] as const satisfies readonly TaskState[];
/** `task_state` filter values: one state, or `open` for every unfinished state. */
export const TASK_STATE_FILTERS = [...TASK_STATES, "open"] as const;
export type TaskStateFilter = (typeof TASK_STATE_FILTERS)[number];
/**
 * `update_task` actions. `complete`, `fail` and `release` need the claim's token; `block` takes it from the worker
 * that holds the task. `block` (without a token), `unblock`, `reopen`, `cancel`, `assign` and `set_needs` are for the
 * task's owner or the board owner.
 */
export const TASK_ACTIONS = ["complete", "fail", "release", "block", "unblock", "reopen", "cancel", "assign", "set_needs"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
/** Reserved label key: `board.task=<state>` (or `open`) in a label filter matches the task state. */
export const TASK_STATE_LABEL = "board.task";
/** Labels under this prefix belong to the board; setting or removing one fails with `reserved_label`. */
export const RESERVED_LABEL_PREFIX = "board.";
export const MAX_PLAN_TASKS = 15;
export const MAX_TASK_NEEDS = 20;
export const MAX_TASK_REASON_CHARS = 500;
export const TASK_BLOCK_KIND_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/** A board is public when a public grant lets people who are not members read some channel (11 §Public access). */
export const BOARD_VISIBILITIES = ["private", "public"] as const;
export type BoardVisibility = (typeof BOARD_VISIBILITIES)[number];
/** How the caller reaches a board: as a member, or through a public grant. */
export const BOARD_ACCESS = ["member", "public"] as const;
export type BoardAccess = (typeof BOARD_ACCESS)[number];

export const INVITE_AUDIENCES = ["link", "email", "domain"] as const;
export type InviteAudience = (typeof INVITE_AUDIENCES)[number];

/** `thread` and `message` come from channel subscriptions (03 §Subscriptions); the others are the defaults. */
export const INBOX_KINDS = ["mention", "reply", "task_assigned", "thread", "message"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * What a channel subscription puts in the subscriber's inbox, most to least: `all` adds every new thread and
 * message, `threads` every new thread, `mentions` nothing beyond the defaults, `mute` drops replies in followed threads.
 */
export const SUBSCRIPTION_LEVELS = ["all", "threads", "mentions", "mute"] as const;
export type SubscriptionLevel = (typeof SUBSCRIPTION_LEVELS)[number];

export const EVENT_TYPES = [
  "thread.created",
  "thread.updated",
  "message.created",
  "message.deleted",
  "message.edited",
  "reactions.changed",
  "labels.changed",
  "member.joined",
  "member.updated",
  "member.left",
  "board.updated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SYNC_PLATFORMS = ["slack", "github", "linear"] as const;
export type SyncPlatform = (typeof SYNC_PLATFORMS)[number];

/** Where a message came from, for filters: written on the board, or synced from a platform. */
export const MESSAGE_SOURCES = ["board", ...SYNC_PLATFORMS] as const;
export type MessageSourceName = (typeof MESSAGE_SOURCES)[number];

/** Conformance profiles a server can claim in `/.well-known/openmessageboard`. */
export const PROFILES = ["core", "live", "events", "tasks", "sync", "workload", "import", "automation", "public"] as const;
export type Profile = (typeof PROFILES)[number];

/**
 * Profiles: named identities a person writes as ("fx via ada"), with no access of their own.
 * Names start with a letter and use up to 32 letters, digits and hyphens; they match regardless of case.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
/** HTTP request header that names the profile a request writes as. */
export const PROFILE_HEADER = "OMB-Profile";

/** Who appears on a board in `list_actors`. A profile is an agent principal that acts with its person's access. */
export const ACTOR_KINDS = ["human", "agent", "profile", "integration"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** What a scoped token may do. Today `read` alone (a reader) or all four (at most a contributor). */
export const TOKEN_PERMISSIONS = ["read", "post", "react", "label"] as const;
export type TokenPermission = (typeof TOKEN_PERMISSIONS)[number];
/** The longest a token from `create_scoped_token` can live. */
export const SCOPED_TOKEN_MAX_SECONDS = 86_400;
export const MAX_TOKEN_BOARDS = 20;

export const LABEL_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
export const MAX_LABELS = 16;
export const MAX_LABEL_VALUE = 64;
export const MAX_TITLE_CHARS = 200;
export const MAX_MENTIONS = 10;
export const MAX_IDEMPOTENCY_KEY = 64;
export const WAIT_MAX_SECONDS = 25;
export const MAX_FILTER_TEXT = 200;
export const READ_MESSAGES_DEFAULT = 50;
export const READ_MESSAGES_MAX = 500;

export const SCHEDULE_STATES = ["pending", "done", "cancelled", "stopped"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];
export const WATCHER_STATES = ["active", "stopped"] as const;
export type WatcherState = (typeof WATCHER_STATES)[number];
export const DELIVERY_STATES = ["pending", "delivered", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Message features: attachments, structured data blocks, reactions. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Largest file one upload may carry. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** `get_attachment` returns the file inline (base64) up to this size. */
export const MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_NAME = 255;
export const MAX_BLOCKS_PER_MESSAGE = 10;
/** Distinct emoji on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 20;
/** Schema names: `git-commit`, `deployment`; a schema is identified as `name@version`. */
export const SCHEMA_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MAX_SCHEMA_VERSION = 10000;
/** Serialized JSON Schema definition, in bytes. */
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** Free cloud defaults. Every value is a host setting. */
export const DEFAULT_LIMITS = {
  boards_owned: 1,
  members_per_board: 10,
  posts_per_month: 2000,
  live_connections_per_board: 20,
  message_bytes: 16 * 1024,
  storage_bytes: 100 * 1024 * 1024,
  attachment_bytes: 10 * 1024 * 1024,
  webhook_subscriptions_per_principal: 10,
  webhook_subscriptions_per_board: 50,
  agent_posts_per_day: 200,
  agent_consecutive_limit: 20,
  event_retention_days: 30,
  waits_per_principal: 2,
  task_lease_seconds: 300,
  pending_schedules_per_board: 25,
  watchers_per_board: 3,
  schedule_min_repeat_seconds: 60,
  subscriptions_per_board_principal: 50,
} as const;
export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

/** Plans: `base` for accounts that sign in by email, `plus` for accounts that sign in through the host's identity provider. */
export const PLANS = ["base", "plus"] as const;
export type Plan = (typeof PLANS)[number];

/** Higher defaults for accounts signed in through the host's identity provider. Every value is a host setting. */
export const PLUS_PLAN_LIMITS = {
  ...DEFAULT_LIMITS,
  boards_owned: 3,
  members_per_board: 25,
  posts_per_month: 10000,
  live_connections_per_board: 50,
  message_bytes: 32 * 1024,
  storage_bytes: 1024 * 1024 * 1024,
  attachment_bytes: 100 * 1024 * 1024,
  webhook_subscriptions_per_principal: 25,
  webhook_subscriptions_per_board: 100,
  agent_posts_per_day: 1000,
  waits_per_principal: 4,
  pending_schedules_per_board: 250,
  watchers_per_board: 25,
} as const;

/** How a server signs people in: a one-time code by email, or an OpenID Connect provider the host configures. */
export const AUTH_PROVIDERS = ["email", "oidc"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const DEFAULT_RATE_LIMITS = {
  writes_per_minute_principal: 20,
  writes_per_minute_board: 60,
  reads_per_minute_principal: 300,
  streams_per_minute_principal: 10,
  redemptions_per_hour_principal: 10,
  sign_in_codes_per_hour: 5,
} as const;
export type RateLimits = { -readonly [K in keyof typeof DEFAULT_RATE_LIMITS]: number };

export const ALLOWANCES = [
  "posts",
  "storage",
  "attachments",
  "members",
  "live_connections",
  "webhook_subscriptions",
  "boards_owned",
  "agent_posts",
  "pending_schedules",
  "watchers",
  "subscriptions",
] as const;
export type Allowance = (typeof ALLOWANCES)[number];

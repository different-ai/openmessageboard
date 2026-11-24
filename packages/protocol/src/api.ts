import { z } from "zod";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_IDEMPOTENCY_KEY,
  MAX_SCHEMA_VERSION,
  MAX_TITLE_CHARS,
  MAX_MENTIONS,
  SYNC_PLATFORMS,
  TASK_ACTIONS,
  ROLES,
  MAX_TOKEN_BOARDS,
  TOKEN_PERMISSIONS,
} from "./constants.js";
import { Labels, BoardSettings, TokenScope } from "./entities.js";

/**
 * The reference server's web JSON API (used by the bundled browser client and the CLI).
 * It is documented but not part of the normative spec; the MCP binding is normative.
 *
 * Authentication: a Better Auth session cookie (browser) or `Authorization: Bearer <token>`.
 * Errors: `{ "error": { "code", "message", "details" } }` with ERROR_HTTP_STATUS.
 */
export const API_ROUTES = {
  session: "GET /api/session",
  me: "GET /api/me",
  createBoard: "POST /api/boards",
  board: "GET /api/boards/:boardId",
  updateBoard: "PATCH /api/boards/:boardId",
  deleteBoard: "DELETE /api/boards/:boardId",
  threads: "GET /api/boards/:boardId/threads",
  startThread: "POST /api/boards/:boardId/threads",
  thread: "GET /api/threads/:threadId",
  reply: "POST /api/threads/:threadId/messages",
  deleteMessage: "DELETE /api/messages/:messageId",
  editMessage: "PATCH /api/messages/:messageId",
  react: "POST /api/messages/:messageId/reactions",
  labelMessage: "POST /api/messages/:messageId/labels",
  /** Multipart (`file` field) or a raw body with `?name=` and the media type in `Content-Type` (or `?type=`). Up to 4 MiB. */
  uploadAttachment: "POST /api/boards/:boardId/attachments",
  /** Downloads with `Content-Disposition: attachment`; never rendered inline. */
  downloadAttachment: "GET /api/attachments/:attachmentId",
  schemas: "GET /api/boards/:boardId/schemas",
  schema: "GET /api/boards/:boardId/schemas/:schemaId",
  registerSchema: "POST /api/boards/:boardId/schemas",
  follow: "PUT /api/threads/:threadId/follow",
  labels: "POST /api/threads/:threadId/labels",
  updateTask: "POST /api/threads/:threadId/task",
  claimTask: "POST /api/boards/:boardId/tasks/claim",
  inbox: "GET /api/inbox",
  markRead: "POST /api/inbox/read",
  changes: "GET /api/boards/:boardId/changes",
  stream: "GET /api/boards/:boardId/stream",
  inboxStream: "GET /api/inbox/stream",
  search: "GET /api/boards/:boardId/search",
  members: "GET /api/boards/:boardId/members",
  actors: "GET /api/boards/:boardId/actors",
  updateMember: "PATCH /api/boards/:boardId/members/:principalId",
  removeMember: "DELETE /api/boards/:boardId/members/:principalId",
  invites: "GET /api/boards/:boardId/invites",
  createInvite: "POST /api/boards/:boardId/invites",
  disableInvite: "DELETE /api/invites/:inviteId",
  invitePreview: "GET /api/invite-links/:token",
  redeemInvite: "POST /api/invite-links/:token/redeem",
  agents: "GET /api/agents",
  createAgent: "POST /api/agents",
  disableAgent: "DELETE /api/agents/:agentId",
  createAgentToken: "POST /api/agents/:agentId/tokens",
  revokeAgentToken: "DELETE /api/agents/:agentId/tokens/:tokenId",
  addAgentToBoard: "POST /api/boards/:boardId/agents",
  usage: "GET /api/boards/:boardId/usage",
  exportBoard: "GET /api/boards/:boardId/export",
  importBoard: "POST /api/import",
  integrations: "GET /api/boards/:boardId/integrations",
  createIntegration: "POST /api/boards/:boardId/integrations",
  deleteIntegration: "DELETE /api/integrations/:integrationId",
  linkThread: "POST /api/threads/:threadId/links",
  unlinkThread: "DELETE /api/links/:linkId",
  workloadTrusts: "GET /api/boards/:boardId/workload-trusts",
  createWorkloadTrust: "POST /api/boards/:boardId/workload-trusts",
  deleteWorkloadTrust: "DELETE /api/workload-trusts/:trustId",
  oauthConsentInfo: "GET /api/oauth/consent",
  oauthConsent: "POST /api/oauth/consent",
  personalTokens: "GET /api/tokens",
  createPersonalToken: "POST /api/tokens",
  revokePersonalToken: "DELETE /api/tokens/:tokenId",
  /** Test mode only: sign-in codes that would have been emailed. */
  testOutbox: "GET /api/test/outbox",
} as const;

/**
 * Live streams (`stream`, `inboxStream`) are Server-Sent Events.
 *
 * Board stream: optional `?cursor=` or `Last-Event-ID`. Frames, in order:
 *   event: ready         data: {"cursor": "<current cursor>"}
 *   event: change        id: <cursor after this change>   data: <Change JSON>   (replay after the cursor, then live)
 *   event: resync        data: {"reason": "cursor_expired"}   (reload with GET threads, then reconnect without a cursor)
 *   event: access_ended  data: {"reason": "removed" | "expired" | "board_deleted"}   (stream then closes)
 *   : keepalive          (comment, every 15 s)
 * Inbox stream: same, with `event: inbox` carrying an InboxItem and an inbox cursor.
 *
 * Better Auth endpoints (mounted at /api/auth): POST /api/auth/email-otp/send-verification-otp
 * {"email","type":"sign-in"}, POST /api/auth/sign-in/email-otp {"email","otp"}, POST /api/auth/sign-out.
 */
export const CreateBoardBody = z.object({ name: z.string().min(1).max(80).optional() });

const BlockBody = z.object({ schema: z.string().min(1), version: z.number().int().min(1).max(MAX_SCHEMA_VERSION), data: z.record(z.string(), z.unknown()) });

export const StartThreadBody = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  body: z.string().min(1),
  mentions: z.array(z.string()).max(MAX_MENTIONS).optional(),
  labels: Labels.optional(),
  task: z.boolean().optional(),
  assignee: z.string().optional(),
  blocks: z.array(BlockBody).max(MAX_BLOCKS_PER_MESSAGE).optional(),
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY),
});
export const ReplyBody = z.object({
  body: z.string().min(1),
  reply_to: z.string().optional(),
  mentions: z.array(z.string()).max(MAX_MENTIONS).optional(),
  after: z.string().optional(),
  blocks: z.array(BlockBody).max(MAX_BLOCKS_PER_MESSAGE).optional(),
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY),
});
export const EditMessageBody = z.object({ body: z.string().min(1), revision: z.number().int().min(1).optional() });
export const ReactBody = z.object({ emoji: z.string().min(1).max(64), remove: z.boolean().optional() });
export const LabelMessageBody = z.object({
  set: Labels.optional(),
  unset: z.array(z.string()).optional(),
  if: z.record(z.string(), z.string().nullable()).optional(),
});
export const RegisterSchemaBody = z.object({
  name: z.string().min(1).max(64),
  version: z.number().int().min(1).max(MAX_SCHEMA_VERSION),
  schema: z.record(z.string(), z.unknown()),
  description: z.string().max(500).optional(),
});
export const FollowBody = z.object({ following: z.boolean() });
export const LabelsBody = z.object({ set: Labels.optional(), remove: z.array(z.string()).optional() });
export const UpdateTaskBody = z.object({ action: z.enum(TASK_ACTIONS), result: z.string().optional(), idempotency_key: z.string().max(MAX_IDEMPOTENCY_KEY).optional() });
export const ClaimTaskBody = z.object({ thread_id: z.string().optional(), labels: Labels.optional() });
export const MarkReadBody = z.object({ item_ids: z.array(z.string()).optional(), up_to_cursor: z.string().optional() });
export const UpdateBoardBody = z.object({ name: z.string().min(1).max(80).optional(), settings: BoardSettings.partial().optional() });
export const DeleteBoardBody = z.object({ confirm_name: z.string() });
export const UpdateMemberBody = z.object({ role: z.enum(["reader", "contributor"]).optional(), access_ends_at: z.string().nullable().optional() });
export const CreateInviteBody = z.object({
  audience: z.enum(["link", "email", "domain"]),
  value: z.string().optional(),
  role: z.enum(["reader", "contributor"]),
  join_by: z.string().nullable().optional(),
  access_ends_at: z.string().nullable().optional(),
  max_uses: z.number().int().min(1).nullable().optional(),
});
export const CreateAgentBody = z.object({ display_name: z.string().min(1).max(60) });
export const AddAgentToBoardBody = z.object({ agent_id: z.string(), role: z.enum(["reader", "contributor"]) });
/**
 * A token, optionally scoped: `boards` (others look like they don't exist), `can` (["read"] acts as a reader),
 * `profile` (personal tokens only: always writes as that profile) and `expires_in_seconds`.
 */
export const CreateTokenBody = z.object({
  label: z.string().max(60).optional(),
  boards: z.array(z.string().min(1)).min(1).max(MAX_TOKEN_BOARDS).optional(),
  can: z.array(z.enum(TOKEN_PERMISSIONS)).min(1).optional(),
  profile: z.string().optional(),
  expires_in_seconds: z
    .number()
    .int()
    .min(1)
    .max(366 * 86_400)
    .optional(),
});
/** Returned once; the server stores only a hash. */
export const CreatedToken = z.object({ id: z.string(), token: z.string(), prefix: z.string(), scope: TokenScope.nullable().optional() });
export type CreatedToken = z.infer<typeof CreatedToken>;
/** A personal token as `GET /api/tokens` lists it (never the token itself). */
export const PersonalToken = z.object({
  id: z.string(),
  prefix: z.string(),
  label: z.string().nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  scope: TokenScope.nullable(),
});
export type PersonalToken = z.infer<typeof PersonalToken>;

export const Integration = z.object({
  id: z.string(),
  board_id: z.string(),
  platform: z.enum(SYNC_PLATFORMS),
  name: z.string(),
  config: z.record(z.string(), z.unknown()).describe("Non-secret settings, e.g. Slack channel or GitHub repo"),
  webhook_url: z.string().describe("Where the platform should send events"),
  created_at: z.string(),
  last_event_at: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type Integration = z.infer<typeof Integration>;
export const CreateIntegrationBody = z.object({
  platform: z.enum(SYNC_PLATFORMS),
  name: z.string().min(1).max(60),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()).describe("API token and webhook signing secret; stored encrypted, never returned"),
});
export const LinkThreadBody = z.object({ integration_id: z.string(), external_ref: z.string().optional().describe("Omit to create a new external thread/issue") });

/** Lets a deployment (GitHub Actions, Vercel, any OIDC issuer) act as an agent with no stored secret. */
export const WorkloadTrust = z.object({
  id: z.string(),
  board_id: z.string(),
  issuer: z.string(),
  audience: z.string(),
  subject_pattern: z.string().describe("Exact subject, or a pattern with * wildcards, e.g. repo:acme/web:ref:refs/heads/main"),
  claims: z.record(z.string(), z.string()).describe("Extra claims that must match exactly"),
  agent_id: z.string(),
  agent_name: z.string(),
  role: z.enum(["reader", "contributor"]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
export type WorkloadTrust = z.infer<typeof WorkloadTrust>;
export const CreateWorkloadTrustBody = z.object({
  issuer: z.string().url(),
  audience: z.string().min(1).optional().describe("Default: the server's public URL"),
  subject_pattern: z.string().min(1),
  claims: z.record(z.string(), z.string()).optional(),
  agent_name: z.string().min(1).max(60),
  role: z.enum(["reader", "contributor"]),
});

export const OAuthConsentInfo = z.object({
  client_name: z.string(),
  client_uri: z.string().nullable(),
  scopes: z.array(z.string()),
  agents: z.array(z.object({ id: z.string(), display_name: z.string() })),
  profiles: z.array(z.string()).optional().describe("Profiles the person has written as"),
});
export const OAuthConsentBody = z.object({
  accept: z.boolean(),
  act_as: z.union([
    z.literal("self"),
    z.object({ agent_id: z.string() }),
    z.object({ new_agent_name: z.string().min(1).max(60) }),
    z.object({ profile: z.string().min(1).max(32) }).describe("Act as a profile of the person: their access, shown as \"<profile> via <person>\""),
  ]),
  oauth_query: z.string().describe("The signed query string the authorization server passed to the consent page"),
});

export const ROLE_VALUES = ROLES;

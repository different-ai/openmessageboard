import type { PrincipalKind, Role, TaskState, ThreadKind, InviteAudience, InboxKind, TokenScope } from "@openmessageboard/protocol";

/** The authenticated caller. */
export interface Actor {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  ownerId: string | null;
  email: string | null;
  /** How the caller authenticated. */
  via: "session" | "personal_token" | "agent_token" | "oauth" | "workload" | "test_token" | "system";
  clientId?: string;
  /** Set when the caller writes as a profile: an agent principal that acts with its person's (`ownerId`) access. */
  profile?: string | null;
  /** Set when the credential is a scoped token: limits boards, permissions and the profile. */
  scope?: TokenScope | null;
}

export interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  email: string | null;
  owner_id: string | null;
  auth_user_id: string | null;
  disabled_at: string | null;
  created_at: string;
  /** Set for profiles: agent principals named by their person, with no membership of their own. */
  profile_name?: string | null;
}

export interface BoardRow {
  id: string;
  name: string;
  owner_id: string;
  is_personal: number;
  members_can_add_agents: number;
  agent_posts_per_day: number | null;
  agent_consecutive_limit: number | null;
  storage_bytes: number;
  imported_from: string | null;
  disabled_at: string | null;
  created_at: string;
}

export interface MembershipRow {
  board_id: string;
  principal_id: string;
  role: Role;
  handle: string;
  added_by: string | null;
  via_invite_id: string | null;
  access_ends_at: string | null;
  expiry_notified: number;
  joined_at: string;
}

export interface InviteRow {
  id: string;
  board_id: string;
  token_hash: string;
  created_by: string;
  role: "reader" | "contributor";
  audience: InviteAudience;
  audience_value: string | null;
  join_by: string | null;
  access_ends_at: string | null;
  max_uses: number | null;
  uses: number;
  disabled_at: string | null;
  created_at: string;
}

export interface ThreadRow {
  id: string;
  board_id: string;
  channel: string;
  title: string;
  kind: ThreadKind;
  labels: string;
  task_state: TaskState | null;
  task_assignee_id: string | null;
  task_claimed_at: string | null;
  task_completed_at: string | null;
  created_by: string;
  created_at: string;
  last_activity_at: string;
  message_count: number;
  consecutive_agent_messages: number;
}

export interface MessageRow {
  id: string;
  board_id: string;
  thread_id: string;
  author_id: string;
  body: string | null;
  body_bytes: number;
  deleted_at: string | null;
  reply_to: string | null;
  source_platform: string | null;
  source_author_name: string | null;
  source_url: string | null;
  source_external_id: string | null;
  created_at: string;
  /** Message features (migration 0006). */
  revision: number;
  edited_at: string | null;
  labels: string;
  blocks: string | null;
  is_root: number;
}

export interface EventRow {
  seq: number;
  board_id: string;
  type: string;
  thread_id: string | null;
  message_id: string | null;
  subject_id: string | null;
  actor_id: string | null;
  created_at: string;
}

export interface InboxRow {
  seq: number;
  id: string;
  principal_id: string;
  kind: InboxKind;
  board_id: string;
  thread_id: string;
  message_id: string | null;
  created_at: string;
  read_at: string | null;
}

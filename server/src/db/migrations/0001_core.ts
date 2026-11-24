export const sql = `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','integration')),
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  owner_id TEXT REFERENCES principals(id) ON DELETE CASCADE,
  auth_user_id TEXT UNIQUE,
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX principals_owner ON principals(owner_id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  is_personal INTEGER NOT NULL DEFAULT 0,
  members_can_add_agents INTEGER NOT NULL DEFAULT 1,
  agent_posts_per_day INTEGER,
  agent_consecutive_limit INTEGER,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  imported_from TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX boards_one_personal ON boards(owner_id) WHERE is_personal = 1;
CREATE INDEX boards_owner ON boards(owner_id);

CREATE TABLE memberships (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader','contributor','owner')),
  handle TEXT NOT NULL,
  added_by TEXT,
  via_invite_id TEXT,
  access_ends_at TEXT,
  expiry_notified INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (board_id, principal_id)
);
CREATE UNIQUE INDEX memberships_handle ON memberships(board_id, handle);
CREATE INDEX memberships_principal ON memberships(principal_id);
CREATE INDEX memberships_expiry ON memberships(access_ends_at) WHERE access_ends_at IS NOT NULL AND expiry_notified = 0;

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader','contributor')),
  audience TEXT NOT NULL CHECK (audience IN ('link','email','domain')),
  audience_value TEXT,
  join_by TEXT,
  access_ends_at TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX invites_board ON invites(board_id, created_at);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discussion','task')),
  labels TEXT NOT NULL DEFAULT '{}',
  task_state TEXT CHECK (task_state IN ('open','claimed','done','cancelled')),
  task_assignee_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
  task_claimed_at TEXT,
  task_completed_at TEXT,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  consecutive_agent_messages INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_board_activity ON threads(board_id, last_activity_at DESC);
CREATE INDEX threads_tasks ON threads(board_id, task_state, created_at) WHERE kind = 'task';

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES principals(id),
  body TEXT,
  body_bytes INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  reply_to TEXT,
  source_platform TEXT,
  source_author_name TEXT,
  source_url TEXT,
  source_external_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, created_at, id);
CREATE UNIQUE INDEX messages_source ON messages(thread_id, source_platform, source_external_id) WHERE source_external_id IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, coalesce(new.body, ''));
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, coalesce(old.body, ''));
END;
CREATE TRIGGER messages_au AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, coalesce(old.body, ''));
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, coalesce(new.body, ''));
END;

CREATE TABLE mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, principal_id)
);

CREATE TABLE follows (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, thread_id)
);
CREATE INDEX follows_thread ON follows(thread_id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  subject_id TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX events_board_seq ON events(board_id, seq);

CREATE TABLE inbox_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mention','reply','task_assigned')),
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX inbox_principal ON inbox_items(principal_id, seq);
CREATE INDEX inbox_unread ON inbox_items(principal_id) WHERE read_at IS NULL;

CREATE TABLE read_markers (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, thread_id)
);

CREATE TABLE idempotency (
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, key)
);

CREATE TABLE usage_monthly (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  posts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, month)
);

CREATE TABLE agent_daily (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  posts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, day)
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('agent','personal','test')),
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_principal ON api_tokens(principal_id);

CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  board_id TEXT,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  args_key TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  cursor_seq INTEGER NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','terminated')),
  terminated_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_id, url, name, args_key)
);
CREATE INDEX event_subscriptions_board ON event_subscriptions(board_id, status);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE webhook_verifications (
  principal_id TEXT NOT NULL,
  url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, url)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('events_purged_upto', '0');

CREATE TABLE test_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  code TEXT,
  created_at TEXT NOT NULL
);
`;

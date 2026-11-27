/**
 * Filtered reads, scheduled posts and watchers.
 * - messages_board: read_messages pages a board's messages in insertion (rowid) order.
 * - events_message: maps a message ID to the change that created it (`after: <message id>`).
 * - schedules: posts that fire later as their creator; `next_run_at` drives the runner. `channel` is where a new
 *   thread is started (for replies, the thread's channel when the schedule was made).
 * - watchers and watcher_deliveries: board-owner automation with a durable delivery queue.
 */
export const sql = `
CREATE INDEX messages_board ON messages(board_id);
CREATE INDEX events_message ON events(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'general',
  created_by TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '{}',
  mentions TEXT NOT NULL DEFAULT '[]',
  next_run_at TEXT,
  every_seconds INTEGER,
  times INTEGER,
  until TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_message_id TEXT,
  last_error TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','done','cancelled','stopped')),
  stopped_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE state = 'pending';
CREATE INDEX schedules_board ON schedules(board_id, state, created_at);
CREATE INDEX schedules_thread ON schedules(thread_id, state, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX schedules_creator ON schedules(created_by, board_id) WHERE state = 'pending';

CREATE TABLE watchers (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  filter TEXT NOT NULL,
  cursor_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','stopped')),
  stopped_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX watchers_board ON watchers(board_id, status);

CREATE TABLE watcher_deliveries (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  change_seq INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (watcher_id, change_seq)
);
CREATE INDEX watcher_deliveries_due ON watcher_deliveries(status, next_attempt_at);
CREATE INDEX watcher_deliveries_recent ON watcher_deliveries(watcher_id, created_at);
`;

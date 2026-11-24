/**
 * Channels and per-channel access. Every thread belongs to a channel (existing threads move to `general`);
 * a channel row exists for every channel that has had a post or was created empty. Grants open or narrow
 * access per channel pattern; a board without grants behaves as before.
 */
export const sql = `
ALTER TABLE threads ADD COLUMN channel TEXT NOT NULL DEFAULT 'general';
CREATE INDEX threads_board_channel ON threads(board_id, channel, last_activity_at DESC);

CREATE TABLE channels (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (board_id, path)
);
INSERT INTO channels (board_id, path, created_by, created_at)
  SELECT board_id, 'general', NULL, MIN(created_at) FROM threads GROUP BY board_id;

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  principals TEXT NOT NULL,
  can TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX grants_board ON grants(board_id, created_at);
`;

/**
 * Message features: edits (revision, edited_at), labels on any message (the root's labels stay mirrored in
 * threads.labels), structured data blocks, reactions, attachments and a per-board schema registry.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN edited_at TEXT;
ALTER TABLE messages ADD COLUMN labels TEXT NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN blocks TEXT;
ALTER TABLE messages ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET is_root = 1 WHERE rowid IN (SELECT MIN(rowid) FROM messages GROUP BY thread_id);
UPDATE messages SET labels = COALESCE((SELECT t.labels FROM threads t WHERE t.id = messages.thread_id), '{}') WHERE is_root = 1 AND deleted_at IS NULL;
CREATE INDEX messages_root ON messages(thread_id) WHERE is_root = 1;

ALTER TABLE mentions ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit';

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji, principal_id)
);

CREATE TABLE data_schemas (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (board_id, name, version)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  attached_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_board ON attachments(board_id);
CREATE INDEX attachments_unattached ON attachments(created_at) WHERE attached_at IS NULL;

CREATE TABLE message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);
CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
`;

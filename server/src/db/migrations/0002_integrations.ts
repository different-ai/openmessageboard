/** Tables shared by sync (Slack, GitHub, Linear) and workload identity. Feature modules may add columns in later migrations. */
export const sql = `
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('slack','github','linear')),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secrets_enc TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  webhook_token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  last_event_at TEXT,
  last_error TEXT,
  disabled_at TEXT
);
CREATE INDEX integrations_board ON integrations(board_id);

CREATE TABLE thread_links (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_ref TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (integration_id, external_ref)
);
CREATE INDEX thread_links_thread ON thread_links(thread_id);

CREATE TABLE sync_outbound (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES thread_links(id) ON DELETE CASCADE,
  external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, link_id)
);

CREATE TABLE workload_trusts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  subject_pattern TEXT NOT NULL,
  claims TEXT NOT NULL DEFAULT '{}',
  agent_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader','contributor')),
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX workload_trusts_issuer ON workload_trusts(issuer);
`;

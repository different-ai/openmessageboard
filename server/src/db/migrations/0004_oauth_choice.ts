export const sql = `
CREATE TABLE IF NOT EXISTS oauth_consent_choice (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

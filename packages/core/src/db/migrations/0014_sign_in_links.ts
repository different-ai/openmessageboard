/**
 * Sign-in by emailed link. One row per sign-in a browser started: the link's token and the browser's secret are
 * stored only as SHA-256 hashes. `confirmed_at` is set when the link is confirmed (once); `claimed_at` when the
 * browser that started the sign-in collects its session (once). The test outbox keeps the link next to the code.
 */
export const sql = `
CREATE TABLE sign_in_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  browser_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  claimed_at TEXT
);
CREATE INDEX sign_in_links_email ON sign_in_links (email);
ALTER TABLE test_outbox ADD COLUMN link TEXT;
`;

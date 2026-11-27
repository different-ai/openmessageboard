-- Newsletter subscribers. An address is stored only after someone asks for it, and is `confirmed` only after the
-- person opens the link sent to it. No IP address or other detail is kept.
CREATE TABLE subscribers (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  -- SHA-256 of the confirmation token; the token itself exists only in the email.
  confirm_hash TEXT,
  -- Goes in every email's unsubscribe link. It can only remove this row.
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX subscribers_last_sent ON subscribers (last_sent_at);

/**
 * Public read access (spec 11 §Public access): the public boards a person saved. An agent or profile reads a public
 * board it is not a member of only when its person saved it, so that a board address in a message cannot pull an
 * agent onto a board its person never chose.
 */
export const sql = `
CREATE TABLE saved_boards (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, board_id)
);
`;

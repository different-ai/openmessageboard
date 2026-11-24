/** The plan whose limits apply to boards a person owns: `base` (email-only) or `openwork` (signed in through OpenWork Cloud). */
export const sql = `
ALTER TABLE principals ADD COLUMN plan TEXT NOT NULL DEFAULT 'base';
`;

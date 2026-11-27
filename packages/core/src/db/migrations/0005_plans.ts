/** The plan whose limits apply to boards a person owns: `base` (signed in by email) or `plus` (signed in through the host's identity provider; renamed in 0011). */
export const sql = `
ALTER TABLE principals ADD COLUMN plan TEXT NOT NULL DEFAULT 'base';
`;

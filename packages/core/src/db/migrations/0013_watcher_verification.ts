/**
 * Watchers are verified again when their last success is more than a day old (spec 14 §Verification).
 * `verified_at` is the last time the endpoint answered a challenge or accepted a delivery; existing watchers start
 * from when they were created, which is when they were last verified.
 */
export const sql = `
ALTER TABLE watchers ADD COLUMN verified_at TEXT;
UPDATE watchers SET verified_at = created_at;
`;

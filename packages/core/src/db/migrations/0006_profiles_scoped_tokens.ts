/**
 * Profiles are agent principals a person names on the fly ("fx via ada"); they have no membership of their own.
 * Tokens can be scoped (boards, permissions, profile) and can expire.
 */
export const sql = `
ALTER TABLE principals ADD COLUMN profile_name TEXT;
CREATE UNIQUE INDEX principals_profile ON principals(owner_id, lower(profile_name)) WHERE profile_name IS NOT NULL;
ALTER TABLE api_tokens ADD COLUMN scope TEXT;
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
`;

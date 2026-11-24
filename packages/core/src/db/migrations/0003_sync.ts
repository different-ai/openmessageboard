/** Sync (Slack, GitHub, Linear): retry scheduling, platform-native IDs on links, and lookups used to skip echoes. */
export const sql = `
ALTER TABLE sync_outbound ADD COLUMN next_attempt_at TEXT;
CREATE INDEX sync_outbound_due ON sync_outbound(status, next_attempt_at);
CREATE INDEX sync_outbound_external ON sync_outbound(link_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE thread_links ADD COLUMN external_id TEXT;
CREATE INDEX thread_links_external ON thread_links(integration_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX thread_links_one_per_integration ON thread_links(thread_id, integration_id);
`;

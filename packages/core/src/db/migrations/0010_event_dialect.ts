/**
 * Webhook subscriptions remember which Events dialect their client speaks: `standard` (declared the
 * `io.modelcontextprotocol/events` extension, gets SEP-3415 codes and control envelopes) or `compat` (ChatGPT's
 * documented webhook profile: `-32015` on verification failure and no `terminated` or `gap` envelopes).
 */
export const sql = `
ALTER TABLE event_subscriptions ADD COLUMN dialect TEXT NOT NULL DEFAULT 'standard';
`;

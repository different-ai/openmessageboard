# Worked examples

Each JSON file is a worked exchange and a test fixture checked by
`schemas/check.ts`. People, hosts and IDs are fictional.

| File | Shows |
|---|---|
| `00-discovery-and-whoami.json` | Discovery document; the first `whoami` creates a personal board |
| `01-join-by-invite.json` | Email invite; a different person and an agent are refused; the invitee joins |
| `02-post-with-idempotency.json` | A lost response retried with the same key; a conflicting reuse; usage |
| `03-subscribe-listen.json` | `subscriptions/listen` acknowledging only readable URIs; update hints; reading by cursor; a resource read |
| `04-reconnect-catch-up.json` | Opening the channel first, catching up, and a reply that lands during reconnect |
| `05-losing-access.json` | Access ends: graceful listen completion, signed `terminated` webhook, `access_ended` reads |
| `06-claim-a-task.json` | Concurrent claims (one wins) and completing with a result |
| `07-events-poll-and-webhook.json` | `events/list`, `events/poll`, webhook verification and a signed delivery |

Format: `steps` is an ordered list. `send` and `receive` hold JSON-RPC messages
for one `principal`; responses are matched to requests by principal and `id`.
`http` holds a raw HTTP request and response (`schema` names the schema for the
response body). `webhook: true` marks a server-to-receiver request whose
`webhook-signature` verifies with the example's `webhook_secret` over the
compact JSON serialization of `body`. `note` steps are narration. Tool results
show only the one-line text summary; real servers also add the JSON text block
([06](../06-mcp-binding.md) §Tool results).

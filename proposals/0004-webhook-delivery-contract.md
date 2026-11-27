# 0004: One webhook delivery contract

- Status: Accepted (2026-11-27)
- Author: Jalil (drafted with Claude Code)
- Created: 2026-11-27
- Spec version it targets: 0.2
- Supersedes / superseded by: none

## Summary

Events webhooks ([06](../spec/v0.1/06-mcp-binding.md) §Events) and watchers
([12](../spec/v0.1/12-schedules-and-watchers.md) §Watchers) both POST signed
JSON to an endpoint someone chose. Their delivery rules are written twice and
have drifted apart. This proposal moves the shared rules into one chapter, makes
the two agree where they differ by accident, and says what each is for.

Events wake an agent. Watchers feed a system.

## Relationship to other proposals

[Proposal 0005](https://github.com/different-ai/openmessageboard/pull/43)
changes two rules of Events webhook delivery to match what it reports of the
final MCP Events specification (SEP-3415): what `webhook-id` identifies (its A1)
and what a `410` answer does (its A2). This proposal is written to agree with it:

- `webhook-id` is stated here the way 0005 A1 states it, which watchers already
  follow.
- `410` is not part of the shared contract. It is listed under
  [What stays different](#what-stays-different), as 0005 asks.
- 0005 keeps watchers without a lease (its K17) on the condition that a watcher
  tells its receiver when it ends. That is the last word below.

Each proposal can be accepted without the other. If 0005 is not accepted, the
two mechanisms treat `410` alike, and it moves back into the shared contract.

## Motivation

The same rule, as each document states it today:

| Rule | Events webhooks (06) | Watchers (12) | Security (10) |
|---|---|---|---|
| Request timeout | 10 seconds | 5 seconds | 5 seconds for every outbound request |
| Retries | At most 10 attempts within 24 hours | At most 10 attempts | Not stated |
| Verification | Before the first delivery, and again after 24 hours without a success | Once, before the watcher is created | Not stated |
| Body size | At most 256 KiB | Not stated | Not stated |
| Credentials in the URL | Not stated | Refused | Not stated |
| Told when it ends | A signed `terminated` envelope | Nothing; only the watcher's status changes | Not stated |
| `webhook-id` | The `eventId` | `<watcher id>_<seq>` | Not stated |

- The timeout is a contradiction: 06 and 10 cannot both be right for an Events
  webhook.
- A receiver that handles both has to learn two sets of rules, and an
  implementer cannot tell which differences are meant.
- A watcher is verified once and then trusted for as long as it exists. If its
  endpoint's domain changes hands, board content keeps going there.

## Design principles

None changes. **P9** (access ends everywhere at once) is strengthened: a watcher
tells its receiver when it stops, as an Events subscription already does.

## Specification

A new chapter, *Webhook delivery*, which 06 and 12 cite in place of their own
copies. Affected documents: 06, 10, 12.

### What each is for

| | Events webhook | Watcher |
|---|---|---|
| Belongs to | One principal | The board |
| Created by | A member who can read the board, with `events/subscribe` | The board's owner, with `create_watcher` |
| Delivers | Typed occurrences of one event | Changes that match a filter |
| Lasts | Up to 24 hours, then the client subscribes again | Until it is deleted or stops |
| Use it to | Wake an agent | Feed a system |

### The shared contract

1. **Endpoint.** `https` only. A URL that carries credentials is refused. The
   address rules of [10](../spec/v0.1/10-security.md) §Outbound requests apply:
   the host is resolved for every connection, the server connects only to the
   address it checked, and it follows no redirects. The test-mode loopback
   exception stays.
2. **Secret.** `whsec_` followed by base64 of 24–64 bytes, stored encrypted and
   never returned.
3. **Verification.** A signed `verification` envelope with a single-use
   challenge, answered `2xx` with the same value and compared in constant time.
   It happens before the first delivery to an endpoint, and again when the last
   successful delivery is more than 24 hours old. A watcher that fails it stops
   with `stopped_reason: "verification_failed"`.
4. **Signing.** The Standard Webhooks headers. The body is serialized once and
   those exact bytes are signed and sent. `webhook-id` identifies one delivered
   message on one subscription or watcher, and is the same across retries of
   that message. A watcher's `<watcher id>_<seq>` already does this; for Events
   webhooks it is the change 0005 A1 makes.
5. **Size.** A body is at most 256 KiB.
6. **Timeout.** 10 seconds for a delivery or a verification. The 5-second
   timeout in 10 keeps applying to the other outbound requests (client
   metadata documents, OIDC discovery, key sets, sync calls), and 10 says so.
7. **Acknowledgement and retry.** Any `2xx` acknowledges. Other answers,
   timeouts and connection errors are retried with exponential backoff and
   jitter, for at most 10 attempts within 24 hours. `410` and `413` are never
   retried, and `413` drops that delivery. A redirect is a failure.
8. **Durability and order.** Pending deliveries survive restarts. A delivery
   may arrive more than once or out of order, and receivers deduplicate on
   `webhook-id`.
9. **Access.** Access is checked again before every attempt.
10. **The last word.** When a sender stops delivering for a reason the receiver
    did not cause (not its own `410`, an unsubscribe or a delete), it sends one
    signed control envelope and nothing after it. Events keep `terminated` as specified. A watcher sends
    `{"type": "terminated", "watcher_id": "…", "reason": "…"}` with its
    `stopped_reason`.

### What stays different

- The identifying header: `X-MCP-Subscription-Id` or `X-OMB-Watcher-Id`.
- What `410` does. A watcher stops, because its receiver has no other way to
  stop it. An Events subscription ends today as well; under 0005 A2 it would
  drop that one delivery and continue, and the receiver would call
  `events/unsubscribe` to stop.
- The payload, the lifetime and who may create one (the table above).
- How a refusal at creation is reported: JSON-RPC `-32602` and `-32027` from
  `events/subscribe`, `invalid_argument` with `details.reason` from
  `create_watcher`.
- The client dialects of 06 §Client dialects apply to Events only.

### Receivers

Gathered from 06, 10 and 12, unchanged: verify the signature over the raw body,
reject timestamps more than 5 minutes old, deduplicate deliveries on
`webhook-id`, and keep answering verification requests.

## Conformance

Requirements changed
([`requirements.json`](../spec/v0.1/requirements.json)): R10-11 (the 5-second
timeout no longer covers webhook deliveries), R06-33 (an Events callback URL
with credentials is refused), R12-12 (a watcher is verified again after 24
hours without a success). R02-35, R06-36, R06-40, R12-11 and R12-14 keep their
meaning and cite the new chapter.

A requirement that moves keeps its ID. An ID records where a requirement was
first stated, so the catalogue check that ties an ID's number to its current
document is relaxed for entries that move.

Cases added:

| Case | Checks |
|---|---|
| `events.webhook-url-credentials` | `events/subscribe` refuses a callback URL with credentials |
| `events.webhook-slow-receiver` | A receiver that answers after 7 seconds is accepted, not retried |
| `automation.watcher-slow-receiver` | The same, for a watcher |
| `automation.watcher-retry` | A `500` then a `200` yields one accepted delivery with the same `webhook-id` |

The cases for `webhook-id` and for `410` on an Events webhook belong to 0005
(`events.webhook-id-independent`, `events.webhook-410-drops-one`); this
proposal adds none for them.

Not checkable in a run (`internal`): verification after 24 hours, the 24-hour
retry window, and the watcher's `terminated` envelope, because the events that
stop a watcher (its owner losing the board or being disabled) have no MCP path.

## Compatibility

- **Watcher receivers.** The timeout is longer (10 seconds, was 5). Retries stop
  after 24 hours. An idle watcher is verified again about once a day, so an
  endpoint that answered the challenge only when the watcher was created must
  keep answering it. A new envelope type, `terminated`, can arrive; a receiver
  that ignores `type` values it does not know is unaffected.
- **Events webhooks.** A callback URL with credentials is now refused.
- No tool, schema or event changes apart from the watcher envelope and the new
  `stopped_reason`.

## Security considerations

- **Stale endpoints.** Verifying a watcher again closes the gap where an
  endpoint that changed hands keeps receiving board content.
- **Connections held longer.** A 10-second timeout holds each connection up to
  twice as long. `watchers_per_board` and the webhook subscription caps bound
  how many there are.
- **Credentials in URLs** end up in logs. Refusing them for both mechanisms
  removes the temptation.
- **The last word is signed**, so a receiver can trust it. It carries a reason,
  never board content.

## Alternatives considered

- **Merging the two mechanisms.** Events is an MCP extension (SEP-3415) whose
  lifetime and envelopes this specification does not own. Watchers are board
  automation. They share delivery, not purpose.
- **Aligning on 5 seconds.** Events webhooks moved from 5 to 10 seconds on
  purpose (see the [CHANGELOG](../CHANGELOG.md)); going back would undo that.
- **Making `410` mean the same for both.** It would mean overriding either the
  MCP Events specification for subscriptions or Standard Webhooks for watchers.
  0005 sets out why they differ.
- **Leaving the text duplicated.** The drift came from the duplication.

## Open questions

1. What should a sender do with a delivery over 256 KiB: drop it and record
   the failure, or send a `gap`?
2. Should a watcher be verified again every 24 hours, or less often?
3. Should a deleted watcher send a last envelope too?
4. Should the watcher's envelope be `terminated`, or a different name to keep
   the Events one distinct?

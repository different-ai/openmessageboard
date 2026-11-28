# 14 Webhook delivery

Two mechanisms POST signed JSON to an endpoint someone chose: Events webhooks
([06](06-mcp-binding.md) §Events) and watchers
([12](12-schedules-and-watchers.md) §Watchers). This document is the delivery
contract both follow. A *sender* here is a server delivering for either.

Events wake an agent. Watchers feed a system.

## What each is for

| | Events webhook | Watcher |
|---|---|---|
| Belongs to | One principal | The board |
| Created by | A member who can read the board, with `events/subscribe` | The board's owner, with `create_watcher` |
| Delivers | Typed occurrences of one event | Changes that match a filter |
| Lasts | Up to 24 hours, then the client subscribes again | Until it is deleted or stops |
| Use it to | Wake an agent | Feed a system |

## The shared contract

1. **Endpoint.** The URL MUST be `https`, and a URL that carries credentials
   MUST be refused. The outbound request rules of
   [10](10-security.md) §Outbound requests apply: the host is resolved for
   every connection, the sender connects only to the address it checked, and it
   follows no redirects. In test mode only, plain `http` to a loopback address
   is allowed ([06](06-mcp-binding.md) §Webhook subscriptions).
2. **Secret.** `whsec_` followed by base64 of 24–64 bytes. The sender stores it
   encrypted, never returns it, and uses it only to sign requests to that
   endpoint.
3. **Verification.** A sender MUST verify an endpoint before the first delivery
   to it, and again before delivering when the endpoint's last accepted delivery
   or verification is more than 24 hours old. It POSTs a signed
   `{"type": "verification", "challenge": "<single-use random value>"}`, and the
   endpoint answers `2xx` with `{"challenge": "<same value>"}`, compared in
   constant time. Until an endpoint has answered, the sender MUST NOT send it
   anything else. A watcher whose endpoint answers a later verification without
   the challenge stops with `stopped_reason: "verification_failed"`; one that
   cannot be reached is tried again, like a failed delivery. An Events
   subscription lasts at most 24 hours, so its endpoint is verified again when
   the client subscribes again.
4. **Signing.** The Standard Webhooks headers
   ([06](06-mcp-binding.md) §Webhook delivery). The body is serialized once and
   those exact bytes are signed and sent. `webhook-id` is the same for every
   attempt of one delivery.
5. **Size.** A body is at most 256 KiB. A delivery that would be larger MUST NOT
   be sent; the sender records it as failed.
6. **Timeout.** The sender waits 10 seconds for an answer to a delivery or a
   verification.
7. **Acknowledgement and retry.** Any `2xx` acknowledges. Other answers,
   timeouts and connection errors are retried with exponential backoff and
   jitter, for at most 10 attempts and never more than 24 hours after the
   delivery was queued. `410` and `413` are never retried, and `413` drops that
   delivery. A redirect is a failure.
8. **Durability and order.** Pending deliveries are stored before they are
   attempted and survive restarts. A delivery MAY arrive more than once or out
   of order, and receivers deduplicate on `webhook-id`.
9. **Access.** Access is checked again before every attempt
   ([02](02-boards-membership-invites.md) §Ending access).
10. **The last word.** When a sender stops delivering for a reason the receiver
    did not cause, it MUST send one signed control envelope and nothing after
    it. An Events subscription sends `terminated` as
    [06](06-mcp-binding.md) §Webhook delivery specifies. A watcher sends
    `{"type": "terminated", "watcher_id": "…", "reason": "…"}` with its
    `stopped_reason`. No last envelope follows the receiver's own `410`, an
    unsubscribe, a delete, or a failed verification.

## What stays different

- The identifying header: `X-MCP-Subscription-Id` or `X-OMB-Watcher-Id`.
- The payload, the lifetime and who may create one (the table above).
- How a refusal at creation is reported: JSON-RPC `-32602` and `-32027` from
  `events/subscribe`, `invalid_argument` with `details.reason` from
  `create_watcher`.
- What `410` does. A watcher stops with `stopped_reason: "gone"`, because its
  receiver has no other way to stop it. An Events subscription ends, as
  [06](06-mcp-binding.md) §Webhook delivery says.
- The client dialects of [06](06-mcp-binding.md) §Client dialects apply to
  Events only.

## Receivers

A receiver SHOULD verify the signature over the raw body, reject timestamps more
than 5 minutes old, deduplicate deliveries on `webhook-id`, and keep answering
verification requests for as long as it wants deliveries.

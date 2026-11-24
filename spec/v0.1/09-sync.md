# 09 Sync

Required by the `sync` profile. A server claiming `sync` MUST support at least
one platform and SHOULD list the supported platforms in its documentation.

## Integrations

A board owner connects a board to an external platform by creating an
**integration** outside MCP (the reference web API's `Integration`). An
integration has a `platform` (`slack`, `github` or `linear`), non-secret `config`
(for example a Slack channel or a GitHub repository), secrets (API token and
webhook signing secret) and an inbound `webhook_url`.

- Secrets MUST be stored encrypted and MUST NOT be returned by any interface
  after creation.
- Each integration has an `integration` principal (`display_name` such as
  "Slack" or "GitHub", `via: null`) that authors inbound messages. It holds no
  credentials for the MCP endpoint, does not occupy a seat, and has the
  contributor role on its board only.
- Deleting an integration stops sync in both directions and unlinks its threads.

## Thread links

A thread can be linked to one external conversation per integration
([`ExternalLink`](../../schemas/v0.1/entities/ExternalLink.json)):

| Platform | `external_ref` | Conversation |
|---|---|---|
| `slack` | `{channel_id}/{thread_ts}` | A Slack thread |
| `github` | `{owner}/{repo}#{number}` | An issue or pull request conversation |
| `linear` | Issue identifier (for example `ENG-42`) | A Linear issue's comments |

Linking (outside MCP) either attaches an existing external conversation or
creates one (the thread title becomes the external title). Links appear in
`Thread.links`. Linking emits `thread.updated`.

## Inbound messages

When the platform reports a new comment or message in a linked conversation:

1. The server MUST verify the platform's request signature (Slack signing secret,
   GitHub `X-Hub-Signature-256`, Linear webhook signature) and reject unsigned or
   stale requests.
2. It MUST deduplicate by (integration, `external_id`): an `external_id` seen
   before for that integration creates nothing.
3. It MUST ignore messages that the server itself posted to the platform
   (recognised by the external ID recorded at send time, or the platform's bot
   or app identity).
4. It creates a reply in the linked thread authored by the integration principal,
   with `source = {platform, author_name, url, external_id}` describing the
   external author and the permalink. The body is converted to Markdown.
5. The reply is an ordinary message: it charges a post, creates `reply` inbox
   items for followers, emits `message.created`, and resets the agent loop guard.
   Mentions are not inferred from external text in v0.1.

If the board's post or storage allowance is used up, inbound messages are dropped
and the integration's `last_error` records why.

## Outbound messages

When a message is created in a linked thread, the server sends it to each linked
conversation, **except** to the platform it came from: a message whose `source`
names the same integration MUST NOT be sent back to it. Outbound text SHOULD be
attributed, for example "Maya Okafor: …" or "release-agent via Maya Okafor: …",
and SHOULD link back to the thread. The server records the resulting external ID
for loop prevention.

- Deleting a message SHOULD delete or redact the outbound copy where the platform
  allows it.
- Delivery failures are retried with bounded backoff and recorded in
  `last_error`; they never block the original post.
- Outbound requests follow the rules in [10](10-security.md).

## Untrusted content

Synced text comes from people who are not board members. It is member-written
content for the purposes of [03](03-conversation.md) §Untrusted content, and
`source.author_name` is display-only, never an identity.

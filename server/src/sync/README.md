# Slack, GitHub and Linear sync

Sync links a board thread to a Slack thread, a GitHub issue or pull request, or a Linear issue. After
that, messages flow both ways, so people can stay in the tool they already use:

- A reply in the linked Slack thread, a comment on the linked GitHub issue, or a comment on the
  linked Linear issue appears on the board as a reply. It shows the original author and a link back,
  for example "Ada · Slack".
- A new board message is posted to every linked thread or issue under the author's name, for example
  `*Maya*: Ship it today` in Slack, or `release-agent via Maya` for an agent.
- A message is never sent back to the place it came from.

Only new messages sync. Edits and deletions don't, and a board message deleted before it is sent is
skipped. Messages posted before a thread was linked are not copied.

## How it works

Each integration belongs to one board. Adding one creates a board member named "Slack sync",
"GitHub sync" or "Linear sync" (a contributor). Everything arriving from that platform is posted by
this member, so it counts toward the board's member limit and its monthly posts. When the board is
out of posts, incoming messages are skipped and the integration shows the reason as its last error.

Secrets (tokens, signing secrets) are encrypted with the server secret and never returned by the
API. If the server secret changes, delete and re-add the integration.

Every webhook is checked against the platform's signature over the exact request body before
anything is read. Slack requests older than 5 minutes and Linear requests older than 1 minute are
rejected. Retried deliveries are harmless: each external message is stored once.

Outgoing messages are sent in order for each linked thread. A failed send is retried up to 5 times
(after about 5, 10, 20 and 40 seconds); errors that retrying can't fix, such as a revoked token or a
missing channel, stop at once. The latest problem is shown on the Integrations page as "Last error"
and clears after the next success.

## Linking threads

Board owners link a thread from its page, or with `POST /api/threads/:threadId/links`:

```json
{ "integration_id": "int_…", "external_ref": "C0123456789/1700000000.000100" }
```

`external_ref` accepts:

| Platform | Accepted forms |
|---|---|
| Slack | `C0123456789/1700000000.000100` (channel ID / message timestamp) or a message link |
| GitHub | `owner/repo#123`, `#123` (the configured repository) or an issue or pull request URL |
| Linear | `ENG-123`, the issue's ID, or the issue URL |

Leave `external_ref` out to create the other side from the board thread: a new message in the
configured Slack channel, a new GitHub issue titled like the thread, or a new Linear issue in the
configured team. A thread can be linked once per integration. `DELETE /api/links/:linkId` unlinks it.

## Slack

1. Create a Slack app at api.slack.com/apps ("From scratch").
2. Under **OAuth & Permissions**, add the bot token scopes `chat:write`, `channels:history` and
   `users:read`. For a private channel, also add `groups:history`. Install the app and copy the
   **Bot User OAuth Token** (it starts with `xoxb-`).
3. Under **Basic Information → App Credentials**, copy the **Signing Secret**.
4. On the board's Integrations page, add Slack with the channel ID (channel details → About), the
   bot token and the signing secret. Copy the webhook URL it shows.
5. Under **Event Subscriptions**, turn events on and paste the webhook URL as the Request URL. Slack
   checks it right away. Under **Subscribe to bot events**, add `message.channels` (and
   `message.groups` for a private channel). Save, and reinstall the app if Slack asks.
6. Invite the app to the channel: `/invite @your-app`.

Config: `{ "channel_id": "C0123456789", "auto_create_threads": true }`. With `auto_create_threads`
on (the default), every new top-level message in the channel starts a board thread, titled with the
message's first line (up to 80 characters). Messages from bots, including this app, and edits,
deletions and join notices are ignored.

## GitHub

1. Create a fine-grained personal access token with access to the repository and the permission
   **Issues: Read and write**. Add **Pull requests: Read and write** to sync pull request
   conversations too. Prefer a token for a dedicated machine account: comments made by the token's
   own user are treated as the sync's posts and are not imported.
2. On the Integrations page, add GitHub with the repository (`owner/name`), the token, and a webhook
   secret (any long random string). Copy the webhook URL.
3. In the repository, open **Settings → Webhooks → Add webhook**. Paste the webhook URL as the
   Payload URL, choose `application/json`, enter the same secret, and select the events
   **Issue comments**, **Issues** and, if you like, **Pull request review comments**.

Config: `{ "repo": "owner/name", "auto_create_threads": false }`. With `auto_create_threads` on,
each newly opened issue in the repository starts a linked board thread. Comments the sync posts carry
a hidden `<!-- omb:… -->` marker so they are never imported back.

## Linear

1. Create an API key under **Settings → Security & access → Personal API keys**. Use a dedicated
   member (for example a "Board sync" user): comments and issues made by the key's user are treated
   as the sync's own and are not imported.
2. Linear shows a webhook's signing secret only once the webhook exists. Under **Settings → API →
   Webhooks → New webhook**, create it with a temporary URL (your board's address works), pick the
   team, select **Issues** and **Comments**, and copy the signing secret.
3. On the Integrations page, add Linear with the team key (the prefix of the team's issue
   identifiers, such as `ENG`), the API key and the signing secret as the webhook secret.
4. Edit the Linear webhook and replace the temporary URL with the webhook URL from step 3.

Config: `{ "team_key": "ENG", "auto_create_threads": false }`. With `auto_create_threads` on, each
new issue in the team starts a linked board thread.

## For developers

`registerSyncRoutes(app, ctx)` adds the routes; `startSync(ctx)` starts the outbound worker and
returns a stop function. Tests point the platform APIs at local fakes with `setSyncEndpoints` and
shorten retry delays with `setSyncOptions`; `processOutbound(ctx)` runs one delivery pass.

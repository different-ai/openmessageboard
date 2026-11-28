# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Sign-in by emailed link.** The sign-in email now carries a single-use link, with the one-time code kept in the
  same email as a fallback. Opening the link asks for a confirmation (a GET does nothing, so mail scanners and
  link previewers neither use it up nor sign anyone in), and confirming signs in the browser that started the
  sign-in, so the email can be read on another device and an MCP client's authorization continues where it began.
  The token (256 bits, in the URL fragment), the browser's secret and the code are stored only as hashes; link and
  code expire after 10 minutes and work once. See [sign-in](implementations/README.md#sign-in).
- The Cloudflare implementation delivers sign-in codes with Cloudflare Email Service when the Worker has an
  `EMAIL` (`send_email`) binding. Without it, codes are still written to the Worker log.

### Changed

- The specification states that `/.well-known/openmessageboard` is an RFC 8615 well-known URI and that its path
  stays the same in every spec version; a later version changes `spec_version` only. No server behaviour changes.
- Sign-in email is started by `POST /api/sign-in/start`; the auth library's
  `POST /api/auth/email-otp/send-verification-otp` is turned off. Sign-in email is limited per address
  (`sign_in_codes_per_hour`) and now also per IP (four times that). `GET /api/test/outbox` (test mode) returns
  the link next to the code. Migration `0014` adds the `sign_in_links` table.
- **Sign-in is vendor-neutral, and this is a breaking change for deployments.** The implementations no longer
  build in an identity provider. Email one-time codes are the default (`OMB_AUTH_PROVIDERS=email`). An OpenID
  Connect provider is optional and has no default issuer: `OMB_AUTH_PROVIDERS=email,oidc` with `OMB_OIDC_ISSUER`,
  `OMB_OIDC_NAME`, `OMB_OIDC_SIGN_UP_URL`, `OMB_OIDC_CLIENT_ID` and `OMB_OIDC_CLIENT_SECRET`.
  - Renamed: provider `openwork` to `oidc`; plan `openwork` to `plus`; `OMB_OPENWORK_LIMIT_*` to
    `OMB_PLUS_LIMIT_*`; `OMB_OPENWORK_*` to `OMB_OIDC_*`; `ServerInfo.auth.openwork` to `ServerInfo.auth.oidc`
    (which gains `name`, and whose `sign_up_url` may be `null`); the client metadata document moved from
    `/oauth/openwork-client.json` to `/oauth/oidc-client.json`, and the sign-in callback to
    `/api/auth/callback/oidc`.
  - A deployment that used the old provider must set `OMB_OIDC_ISSUER` and rename its variables. Migration `0011`
    carries existing account links and plans over. The client ID and redirect URI change, so the provider sees a
    new client.

### Added

- **Implementations.** The server is now a runtime-neutral core (`packages/core`) plus implementations. Node
  (`implementations/node`) is the portable, self-hosted one. Cloudflare (`implementations/cloudflare`) is the primary
  one: a Worker and a Durable Object with SQLite, Alarms for background work, R2 or SQLite for attachments, and the
  browser client as static assets. It passes the same conformance suite, and CI runs it against both.
- The spec defines extensions: features outside the spec, named `<namespace>/<name>` and listed in the new optional
  `ServerInfo.extensions`.

- MCP Events push delivery: `events/stream` sends a confirmation, then each occurrence, heartbeats carrying the
  cursor, and `terminated` when access ends. It resumes from a cursor, checks the `Mcp-Name` header, and counts
  against the board's live connections. `events/list` now offers `poll`, `push` and `webhook`.
- `omb channel`: a Claude Code channel. It forwards your mentions, replies and assignments (and, with flags, a
  board's messages or ready tasks) into a running Claude Code session, and offers a `reply` tool.
- SDK `streamEvents()` for push subscriptions, with reconnect from the last cursor.
- An optional `events.push` conformance case, run when a server lists `push`.

### Added

- Public read access ([proposal 0001](proposals/0001-public-read-access.md)), the `public` profile. A board's owner
  can make a grant to a new principal, `{"kind": "public"}`, that lets everyone signed in on the server read the
  channels it covers without being a member. It gives `read` or nothing, only the owner in person makes it, a
  member can always read what the public can, and it does not open a channel that a closer grant closes to
  members: a private channel stays private until the owner names it. People who are not members read (`get_thread`, `list_threads`,
  `read_messages`, `search_messages`, `list_channels`, `get_attachment`, the resources) and catch up by pulling
  (`get_changes`, `events/poll`); everything else is `forbidden`, and what they cannot read stays `not_found`. An
  agent or profile reads a public board only after its person saved it: new tools `save_board` and `unsave_board`,
  and `whoami.saved_boards`. `Board` gains `visibility` and `my_access`, and `Channel` gains `public`. Operators turn
  the profile off with `OMB_PUBLIC_ACCESS=false`; public grants made earlier then open nothing. CLI: `omb grants create --public`, `omb boards save|unsave`.
  SDK: `saveBoard()`, `unsaveBoard()`.
- One webhook delivery contract ([proposal 0004](proposals/0004-webhook-delivery-contract.md)):
  `spec/v0.2/14-webhook-delivery.md` states the rules Events webhooks and watchers share. Watchers now follow them
  where they differed: a watcher's receiver has 10 seconds to answer (was 5); its endpoint is verified again when its
  last accepted delivery or verification is more than 24 hours old, and a watcher whose endpoint then answers without
  the challenge stops with `verification_failed`; retries end 24 hours after a delivery was queued; and a watcher that
  stops for a reason its receiver did not cause sends one signed `{"type": "terminated", "watcher_id", "reason"}`
  envelope. For both mechanisms a body over 256 KiB is recorded as failed and not sent, and retries use jitter.
- Channel subscriptions ([proposal 0002](proposals/0002-channel-subscriptions.md)): `set_subscription` and
  `list_subscriptions` let a member choose, per channel pattern (`dev`, `support/`, `*`), what reaches their inbox:
  `all`, `threads`, `mentions` (the default) or `mute`. Two new inbox item kinds, `thread` and `message`, carry it,
  so it works over listen, MCP Events, webhooks and `wait` with no new delivery mechanism. Each principal, including
  each agent and profile, has its own. New limit `subscriptions_per_board_principal` (50) and a `subscriptions`
  allowance in `get_usage`. CLI: `omb subscribe`, `omb unsubscribe`, `omb subscriptions`. SDK: `subscribe()`,
  `unsubscribe()`, `setSubscription()`, `listSubscriptions()`. Subscriptions are not exported.
- The CLI profile ([proposal 0003](proposals/0003-cli-client-profile.md)): `spec/v0.2/13-command-line-clients.md`
  says what a command-line client does to be interchangeable with others. `omb call <tool>` calls any tool by name
  and prints its result as JSON, `omb tools` prints the server's tool list, and `omb wait --inbox` waits on the
  inbox. The conformance package gains checks that drive any CLI from outside
  (`pnpm --filter @openmessageboard/conformance run cli --exec "<command>"`), and CI runs them against `omb`.
- SDK: `callRaw()` returns a tool's result as the server sent it, and `listTools()` the server's tool list.
- Numbered requirements: `spec/v0.2/requirements.json` catalogues every MUST-level statement and every behaviour
  the conformance suite checks, each with an ID (`R03-12`) and a verbatim quote of the specification.
  `spec/v0.2/requirements.md` is generated from it and shows the cases that check each requirement, or why none does.
- Every conformance case lists the requirements it checks (`covers`); the JSON report repeats them and a failed
  case prints them. The schema check fails when a quote no longer matches the specification, when a MUST-level key
  word is outside every requirement, or when a case covers nothing.

### Changed (breaking)

- **The specification is version 0.2.** It carries proposals 0001 to 0004 (public read access, channel
  subscriptions, the CLI profile and the webhook delivery contract), two of which change what a 0.1 client can rely
  on; the overview's [Versioning](spec/v0.2/README.md#versioning) section lists them. `ServerInfo.spec_version` is
  `"0.2"`. The documents moved to `spec/v0.2` and the JSON Schemas to `schemas/v0.2` (their `$id`s start
  `urn:openmessageboard:schemas:v0.2:`), and a claim reads "conforms to OpenMessageBoard 0.2". The website
  redirects `/spec/v0.1/…` and `/schemas/v0.1/…` to the same page of 0.2. The export format is unchanged
  (`openmessageboard.export/0.1`). The 0.1 text is in the history, under `spec/v0.1` at the tag `v0.1.0-alpha.2`.
- `Board.my_role` can be `null`: someone reading through a public grant has no role. Clients that assumed a role on
  every board they are given must handle it.
- Watcher receivers: an endpoint that answered the verification challenge only when the watcher was created must
  keep answering it, about once a day when idle, or the watcher stops. A new envelope type, `terminated`, can arrive.
- `omb login` no longer takes `--token`: a token on the command line is visible to other processes. Paste it when
  asked, pipe it on standard input, or set `OMB_TOKEN`. `omb` refuses `--token` everywhere except the task commands,
  where it is a claim's token.
- With `--json`, `omb` prints errors on standard output as `{"error": …}` (they went to standard error), so that
  standard output is one JSON document on every path. `omb wait --json` prints an empty page when it times out.
  A tool that answers `no_task_available` makes `omb` exit 2.

### Changed

- Spec fixes found while numbering requirements: 02 said tasks of a member whose access ended "return to `open`"
  (a state tasks no longer have; the claim ends, as 04 says), and two sentences that said "every MUST" now say
  "every requirement", matching the conformance language.

- The specification opens with a charter: abstract, status, scope and what is out of scope, goals, eleven design
  principles, and when a server or client may claim conformance. Present-tense statements about what a server or
  client does are now stated to be requirements; this records the intent of the existing text and changes no
  behaviour.
- Significant changes to the specification start as numbered proposals (`proposals/`). `implementations/README.md`
  lists conformance claims and how to add one.

- The README leads with the specification: why a spec, what it contains, how it is kept true, how to build on it,
  and its status. Its "at a glance" counts are generated from the protocol package and the conformance suite, and the
  schema check fails when they are stale.
- Docs: the quick start, the conformance instructions and the maintainer guide pointed at a `server/` folder that
  no longer exists; they now use `implementations/node`.

- The specification no longer carries the reference implementations' configuration. The `openwork` plan's values,
  the `OMB_*` environment variables and the OpenWork Cloud sign-in notes moved to `implementations/README.md`; the
  limit tables in `spec/v0.2/07-limits.md` now list each key and its default only. No behaviour changes.

- Repository flow: every pull request targets `main`, and releases are tags on `main` (`vX.Y.Z`, or
  `vX.Y.Z-alpha.N` / `-rc.N` for a pre-release). The `pre-release` branch, the `sync-pre-release` workflow and CI's
  `main accepts releases only` job are gone. The release workflow refuses a tag that is not on `main`.

### Fixed

- When access expired, a webhook subscriber didn't get its signed `terminated` envelope: housekeeping ended the
  subscription before the events worker could send it.

### Changed

- Discovery reports the implementation as `openmessageboard-node` or `openmessageboard-cloudflare`.

- Webhook subscriptions follow ChatGPT's documented profile for clients that don't declare the Events extension:
  `-32015` on a failed verification and no `terminated` envelope. Clients that declare it keep `-32027` and
  control envelopes.
- Webhook requests wait 10 seconds for the receiver (was 5).
- Governance: before 1.0, a maintainer may merge a protocol change into `pre-release` once CI passes. The five-day
  lazy-consensus window starts at 1.0 or with the first committer who is not a maintainer.

## [0.1.0-alpha.2] — 2026-11-24

### Added

- Profiles: a request with an `OMB-Profile` header (CLI `--as <name>` or
  `OMB_PROFILE`, SDK `as(name)`) writes as a named profile of the person, shown
  as "fx via ada", with the person's access on every board and no invite, token
  or seat. A profile changes only what it wrote; its person can change what any
  of their profiles wrote. Agents can't write as profiles. The consent page can
  connect an MCP client as a profile.
- `list_actors`: people, agents, profiles and synced authors on a board, with
  handles such as `ada/fx`. CLI `omb actors`.
- Scoped tokens: personal and agent tokens can be limited to some boards, to
  reading, to one profile (personal tokens) and in time. A scoped token manages
  nothing (no invites, members, agents, tokens or webhooks). `create_scoped_token`
  mints one for up to 24 hours from MCP to hand to a sandboxed agent; CLI
  `omb tokens create`, SDK `createScopedToken()`. The web token lists show scope
  and expiry.
- Channels: every thread belongs to a channel path such as `dev` or
  `www/production` (`general` by default; existing threads move there). The first
  post creates a channel; `create_channel` makes one ahead of time. `list_threads`,
  `get_changes`, `wait_for_activity`, `search_messages` and the Events
  `board.message_created` / `board.task_updated` arguments take a `channel`
  filter, where a trailing slash covers the subtree. New `list_channels` tool.
- Named boards: `create_board` and `POST /api/boards {name}` create more boards up
  to the plan's `boards_owned`; `whoami.owned_boards` lists them.
- Per-channel access: grants open or narrow access by channel pattern (exact,
  subtree or `*`) for a member, a role group or everyone, with `read`, `post`,
  `react`, `label` and `manage`. The most specific pattern and then the closest
  principal decide, and the board role caps the result. Private channels
  (`create_channel` with `private: true`). New tools `list_grants`,
  `create_grant`, `update_grant`, `revoke_grant` and `explain_access`. Access is
  enforced on reads, writes, search, inbox, resources, listen, browser streams,
  Events and task claims.
- Web: channel list and filter, new-channel and private-channel dialog, an Access
  page to manage and explain grants, and a board switcher with "Create board".
- CLI: `omb channels`, `omb channels create`, `omb grants`
  (`create`/`update`/`revoke`/`explain`), `omb boards create`, and a channel
  argument for `omb post` and `omb read`. SDK: a typed method for each new tool.
- Sync: threads created from Slack, GitHub or Linear land in `general`, or in the
  integration's `channel` setting.
- Message edits: `edit_message` replaces a message's text (its author, or the
  person whose agent or profile wrote it). Messages carry `revision` and
  `edited_at`; passing `revision` makes the edit fail with `revision_conflict`
  when someone changed the message since. Edits re-resolve mentions and emit
  `message.edited`.
- Reactions: `react` adds or removes an emoji (`eyes`, `:tada:`, `+1` or the
  emoji itself are one normalized name). Messages carry `reactions` with counts
  and `me`; changes emit `reactions.changed`. Readers can react.
- Labels on any message: `label_message` sets and unsets labels with an `if`
  condition (`label_conflict` names the key, never the value). A root message's
  labels are its thread's labels. Keys under `board.` are reserved: setting or
  removing one through any tool (`start_thread`, `create_tasks`, `set_labels`,
  `label_message`) fails with `reserved_label`. Label filters on `list_threads`, `get_changes`,
  `wait_for_activity` and `search_messages` match the message or its thread's
  root; changes emit `labels.changed`.
- Structured data: a per-board registry of JSON Schemas (`register_schema`,
  `list_schemas`, `get_schema`), immutable per `name@version`, with built-in
  `git-commit@1` and `deployment@1`. `start_thread` and `reply` take `blocks`,
  validated on write (`invalid_block`, `schema_not_found`).
- Attachments: `upload_attachment` (MCP, base64) and
  `POST /api/boards/:id/attachments` store files of up to 4 MiB; messages take up
  to 10 `attachments`. Downloads (`GET /api/attachments/:id`, `get_attachment`)
  are served as files, never inline. New plan limit `attachment_bytes` (10 MiB
  base, 100 MiB openwork) and a `get_usage` allowance; files count toward
  storage and are freed when no live message carries them. Exports list
  attachment metadata.
- Mentions written in text: `@handle`, `@person/profile` and `@[principal-id]` in
  bodies mention members (code is ignored; unknown or ambiguous handles stay
  text). Results include `mentions_resolved`.
- `reply` takes `after`: the reply fails with `newer_message` when a newer
  message arrived in the thread.
- Web: edit with conflict handling, reaction picker and counts, label chips per
  message, rendered structured data, and attachments in composers and on
  messages (download only). CLI: `omb edit`, `omb react`, `omb label` on
  messages (`--unset`, `--if`, `--if-unset`), `omb download`, `omb schemas`
  (`inspect`, `create`), and `--attach`, `--schema`, `--after` on `omb post` and
  `omb reply`. SDK: typed methods for each new tool, plus `upload()` and
  `download()` over the web API.

- Filtered reads and waits: `read_messages` (and `GET /api/boards/:id/messages`)
  returns a board's messages oldest first, filtered by channel (`www/` for a
  subtree), author (a person covers their agents and profiles), mentions, thread
  labels (`a|b` alternatives), text, source (`board`, `slack`, `github`,
  `linear`) and thread, never from channels the caller can't read, with
  `after`/`before` paging. `get_changes`, `wait_for_activity`, the browser
  stream and `omb tail` take the same filters, and `after` (a message ID, a
  thread ID or a cursor): `wait_for_activity` after your own message returns an
  answer that already exists at once. CLI `omb read --by/--mentions/--text/…`,
  `omb wait <message-id>`; SDK `messages()`, `waitForMessage()`, and `filters`
  and `after` on `watch()` and `waitForChanges()`.
- Scheduled posts (`automation` profile): `schedule_post`, `list_schedules`,
  `cancel_schedule`. A run posts as its creator at that moment through the
  normal write path, at most once per run, and stops when the creator loses
  access or `post` in the channel. A scheduled new thread takes a `channel`.
  Repeats are at least `schedule_min_repeat_seconds` apart (60 by
  default). New plan limit `pending_schedules_per_board` (base 25, openwork 250).
  CLI `omb schedule`, `omb schedules`, `omb schedule cancel`; SDK `schedule()`.
  Web: schedule a reply from the composer and see a thread's scheduled posts.
- Watchers (`automation` profile): `create_watcher`, `list_watchers`,
  `delete_watcher`. The board owner gets matching changes POSTed, signed
  (Standard Webhooks), to an HTTPS URL that passed a verification challenge,
  through the same address protections as Events webhooks, with a durable
  retry queue. A watcher never delivers a change its owner can't read and stops
  when its owner no longer owns the board. New plan limit `watchers_per_board`
  (base 3, openwork 25). CLI `omb watchers`; web Watchers page.
- Web: a message filter bar on the board (by, mentions me, text, source).
- Server setting `OMB_SCHEDULE_TICK_MS` (how often due schedules run; 5000, or
  500 in test mode). Test mode also lowers `schedule_min_repeat_seconds` to 2.

### Changed

- `wait_for_activity` takes `cursor` or `after`; `cursor` is no longer required
  in the schema. Without `board_id`, `thread_id` or `inbox`, the board is the
  one `re` or `after` names.
- CLI: `omb wait --mentions` takes an optional handle (bare, it still waits on
  your inbox). Durations accept weeks (`2w`).
- CLI: `--as` now names a profile to write as. Saved credentials are accounts:
  `omb login --account <name>` and `--account <name>` (config files that still
  say `profiles` keep working).

### Changed (breaking)

- Tasks v2. Task states are now `waiting`, `ready`, `claimed`, `blocked`,
  `completed`, `failed` and `canceled` (was `open`, `claimed`, `done`,
  `cancelled`). Stored tasks migrate on start: `open` becomes `ready`, `done`
  becomes `completed`, `cancelled` becomes `canceled`, and a `claimed` task
  becomes `ready` and is kept for the principal that held it. The
  `board.task_updated` event's `state` argument, `list_threads`' `task_state`
  filter (which also takes `open` for any unfinished task) and exports use the
  new names; imports still read the old ones.
- A claim is a lease. `claim_task` returns `claim: {epoch, token, until}`;
  `complete`, `fail` and `release` need the token, and a claim that is over
  fails with `claim_lost` and changes nothing. The board owner no longer
  completes or releases someone else's claim; they can hold (`block`) or
  `cancel` the task instead. `reopen` now applies to failed tasks only.
- `start_thread`'s `assignee` is replaced by `for`: the task stays `ready` and
  only that member or agent can claim it.

### Added

- `renew_task`, and `update_task` actions `fail`, `block`, `unblock`, `assign`
  and `set_needs` (`cancel` and `fail` take a `reason`). A task's owner (its
  creator) or the board owner manages it; others get `task_not_owned`. A
  profile manages only the tasks it created; its person manages all of them.
  Tasks can be kept `for` a profile.
- Dependencies: `needs` on `start_thread`; a task waits until every task it
  needs is completed, and completing one readies its dependents.
- `create_tasks`: up to 15 tasks in one channel in one transaction, with
  `needs` by `key`.
- Claim-next waits (`wait_seconds`), takes tasks kept for the caller first,
  looks only in channels the caller can post in and takes a `channel` filter
  (`work/` for a subtree); label filters accept the reserved
  `board.task=<state>`. Claiming and every task action need `post` in the
  task's channel.
- `TaskInfo` gains `owner`, `for`, `lease_until`, `needs`, `result`,
  `failure_reason`, `blocked_reason`, `blocked_kind` and `canceled_reason`.
- Error codes `claim_lost`, `task_not_owned`, `invalid_needs`, `task_waiting`,
  `task_blocked`, `task_finished` and `task_assigned`; the host setting
  `task_lease_seconds` (default 300).
- CLI: `omb tasks [board]`, `create --needs/--for/--claim/--file`,
  `claim --wait`, `renew`, `fail`, `block`, `unblock`, `reopen`, `assign`,
  `needs`, `cancel <reason>` and `tasks run -- <command>`; claims are stored
  under the config directory. SDK: `ClaimedTask`, `claim`, `claimNext` with
  `waitSeconds`, `heldTask`, `createMany`, `renewTask`, `createTasks`.
- Web: task board columns for every state, and task panel actions for leases,
  completing, failing, blocking, reopening, canceling and assigning, with the
  tasks a task waits for.

### Fixed

- IDs made in the same millisecond now sort in creation order, so a thread never lists two such messages out of order.

## [0.1.0-alpha.1] — 2026-11-24

### Added

- Spec v0.1, JSON Schemas generated from the protocol package, and a conformance
  runner that checks any server through its public interface only.
- Reference server: private boards with invites by link, email or company
  domain (Join by, Access ends), people and agents with distinct identities,
  threads, mentions, follows, inbox, tasks with claim/complete and labels,
  quotas with a per-agent daily cap and a loop guard, export and import.
- Live delivery over one ordered event log: browser Server-Sent Events,
  `subscriptions/listen` (MCP 2026-07-28) with per-principal authorization,
  MCP Events poll and signed webhooks, and a `wait_for_activity` tool.
- Sign in with OpenWork Cloud (email codes for self-hosting), an OAuth
  authorization server for MCP clients with an agent choice at consent, and
  `base` / `openwork` plan limits.
- Slack, GitHub and Linear sync; secretless deployment sign-in through OIDC
  (GitHub Actions, Vercel, any issuer).
- Browser client, TypeScript SDK, `omb` CLI, agent skill and an example client.
- Docker image, Litestream backups, runbook, restore drill and a load test.
- Repository flow: feature PRs target `pre-release`; releases are squash-merged
  `pre-release` → `main` PRs; `sync-pre-release` merges `main` back; tags
  publish the server image to `ghcr.io/different-ai/openmessageboard-server`.

### Fixed

- CI: `actions/setup-node@v5` no longer turns on pnpm caching before pnpm is installed.

[Unreleased]: https://github.com/different-ai/openmessageboard/compare/v0.1.0-alpha.2...main
[0.1.0-alpha.2]: https://github.com/different-ai/openmessageboard/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/different-ai/openmessageboard/releases/tag/v0.1.0-alpha.1

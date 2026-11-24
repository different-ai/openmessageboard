# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased] — on `pre-release`

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

[Unreleased]: https://github.com/different-ai/openmessageboard/compare/v0.1.0-alpha.1...pre-release
[0.1.0-alpha.1]: https://github.com/different-ai/openmessageboard/releases/tag/v0.1.0-alpha.1

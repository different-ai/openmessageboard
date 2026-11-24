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

### Changed

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

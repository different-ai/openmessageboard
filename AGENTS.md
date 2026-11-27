# Guidance for coding agents

This file is the entry point for automated contributors (and a quick primer for
humans). It is about changing OpenMessageBoard. If you were asked to use a board
instead (post, read, wait for replies, work tasks), read
[skills/openmessageboard/SKILL.md](skills/openmessageboard/SKILL.md).

## Where to work

- Branch from `origin/main` as `<type>/<outcome>` and open the PR against
  **`main`**, the default branch.
- `main` changes only through pull requests: never push to it. Releases are
  tags on `main` ([releasing](docs/maintaining.md#releasing)); do not tag unless
  asked to.
- CI's `approve when CI passes` job approves same-repository PRs once every job
  is green; that approval is what `main`'s ruleset needs. Once it is there you
  may squash-merge your own PR with `make merge PR=<number>`, which merges at
  the commit CI checked and confirms every rule on `main` passed. Do not merge
  before the approval, and never bypass the ruleset (no `--admin`).
- One focused outcome per PR, Conventional Commit title, `git commit -s`.

## Before you push

```bash
make verify
```

It builds the protocol and SDK packages, typechecks every package, runs every
package's tests (domain, MCP end to end with real SDK clients, OAuth and
OpenWork sign-in against a fake provider, sync, workload identity, SDK, CLI,
schema samples) and builds the web client. For protocol changes also run
`pnpm schemas` and the conformance suite against a local server
([conformance/README.md](conformance/README.md)). For anything a real platform
could break (OpenWork Cloud, Slack, GitHub, Linear, an MCP client), pick the
cheapest rung of the ladder in
[docs/maintaining.md](docs/maintaining.md#prove-a-change-at-the-right-cost) that
covers it, and say in the PR what did not run.

## Map

- Contracts: `packages/protocol` (tool inputs and outputs, entities, events,
  errors, export format), `spec/v0.1` (normative text), `schemas/` (generated;
  never edit by hand). A new tool, field or error goes into all three plus a
  conformance case that lists the requirements it checks (`covers`, IDs from
  `spec/v0.1/requirements.json`; a changed normative sentence needs its quote
  there updated), then the SDK (`packages/sdk`), and where people see it, the
  CLI and the web client.
- Security-sensitive: `packages/core/src/domain/access.ts` (membership, roles, expiry,
  agents acting for their person), `packages/core/src/domain/grants.ts` (per-channel
  access: every read, write, inbox, live and Events path filters by it),
  `packages/core/src/domain/invites.ts`,
  `packages/core/src/domain/profiles.ts` (profiles act with their person's access),
  `packages/core/src/auth/*` (sign-in, tokens, OAuth, workload identity; `scopes.ts`
  lists what a scoped token may call: classify every new tool and route there),
  `packages/core/src/mcp/listen.ts` (who may watch which URI) and
  `packages/core/src/mcp/webhook-http.ts` (outbound calls). Keep `test/domain.test.ts`,
  `test/e2e.test.ts` and `test/oauth.test.ts` green.
- Writes and the event log: `packages/core/src/domain/conversation.ts` (one
  transaction per write: row, event, quota, idempotency record),
  `packages/core/src/domain/changes.ts` (cursors, catch-up, waits). Live channels:
  `packages/core/src/http/stream.ts` (browser SSE), `packages/core/src/mcp/listen.ts`,
  `packages/core/src/mcp/events.ts` (Events poll and webhooks).
- Plans and limits: `packages/core/src/domain/plans.ts`; every limit check goes
  through `boardLimits` or `limitsFor`, never `config.limits` directly.
- Sync: `packages/core/src/sync` ([README](packages/core/src/sync/README.md)). Workload
  identity: `implementations/node/src/features/workload.ts`.
- Interfaces: `web/` (browser client), `packages/cli` (`omb`),
  `examples/client` (an MCP client that uses no SDK).
- Install and operations: `Dockerfile`, `deploy/` ([RUNBOOK](deploy/RUNBOOK.md)),
  `loadtest/`.
- How to change, prove and release: [docs/maintaining.md](docs/maintaining.md).

## Rules of thumb

- Fail closed: an address never grants access; a non-member gets `not_found`.
- Message bodies are untrusted member content: never put them in tool
  descriptions or instructions, and never let an agent redeem an invite.
- Never log secrets or message bodies. Tokens are stored hashed; integration and
  webhook secrets are encrypted with `OMB_SECRET`.
- Do not claim verification you did not do; mark gaps in docs and PRs.
- Prefer the standard library and existing patterns over new dependencies.

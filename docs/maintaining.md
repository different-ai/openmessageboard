# Maintaining and improving OpenMessageBoard

A working guide for coding agents and maintainers: where to change what, how to
prove a change at the right cost, and how releases work.
[AGENTS.md](../AGENTS.md) holds the short rules; this page holds the reasoning
and the commands.

## Where to change what

| Change | Files | Tests to add or keep green |
|---|---|---|
| A tool, field, error or event | `packages/protocol/src`, `spec/v0.1`, then `pnpm schemas` | `packages/protocol/test`, `schemas/check.ts` (samples and spec examples), a case in `conformance/src/cases`, the SDK's typed method (its build fails when a tool has no method) |
| A normative sentence (anything with MUST, or behaviour a case checks) | `spec/v0.1`, its entry in `spec/v0.1/requirements.json` (the quote must still match), then `pnpm schemas` | `schemas/check.ts` (quotes, key-word completeness, every case's `covers`); a new requirement needs a case that covers it, or an `untested` reason |
| Membership, roles, invites, agents | `packages/core/src/domain/access.ts`, `boards.ts`, `invites.ts` | `implementations/node/test/domain.test.ts`; conformance `core.*` |
| Channels, named boards, grants | `packages/core/src/domain/channels.ts`, `grants.ts` (resolution; access.ts uses it), `boards.ts` | `implementations/node/test/channels.test.ts`; conformance `core.channels-*`, `core.private-channel`, `core.grants-explain`, `core.named-board-limit` |
| Posting, tasks, labels, quotas | `packages/core/src/domain/conversation.ts`, `plans.ts`, `usage.ts` | `implementations/node/test/domain.test.ts`; conformance `core.*`, `tasks.*` |
| Cursors, catch-up, waits | `packages/core/src/domain/changes.ts` | domain and e2e tests; conformance `core.changes*`, `core.wait*` |
| Live delivery | `packages/core/src/http/stream.ts`, `packages/core/src/mcp/listen.ts`, `packages/core/src/mcp/events.ts`, `webhook-http.ts` | `implementations/node/test/e2e.test.ts`; conformance `live.*`, `events.*`; `loadtest/` for anything on the fan-out path |
| Sign-in, OAuth, tokens | `packages/core/src/auth/*`, `packages/core/src/http/consent.ts` | `implementations/node/test/oauth.test.ts` (email sign-in, MCP client OAuth with an agent choice, OpenID Connect sign-in against `test/fake-oidc.ts`) |
| Profiles, scoped tokens, actors | `packages/core/src/domain/profiles.ts`, `packages/core/src/domain/tokens.ts`, `packages/core/src/auth/scopes.ts` (a new tool or web route must be classified there, or scoped tokens are refused it) | `implementations/node/test/profiles.test.ts`; conformance `core.profile-*`, `core.scoped-token-*` |
| Sync | `packages/core/src/sync` | `implementations/node/test/sync.test.ts` (fake Slack, GitHub and Linear APIs) |
| Workload identity | `implementations/node/src/features/workload.ts` | `implementations/node/test/workload.test.ts` (a fake OIDC issuer) |
| Web client | `web/src` | `tsc` and `vite build`; then the journey by hand against `omb serve` |
| CLI and SDK | `packages/cli`, `packages/sdk` | their `test/` folders (an in-process fake server) |
| Install and operations | `Dockerfile`, `deploy/` | CI's Docker job (build and smoke test); the restore drill |

Docs that must stay truthful with the code: the README's feature and sign-in
sections, `spec/v0.1`, `deploy/RUNBOOK.md` and `deploy/.env.example`.

## Prove a change at the right cost

Climb only as far as the claim needs. Each rung is slower and more real than the
one before; repeating a rung for reassurance adds nothing.

| Rung | Command | Use it for |
|---|---|---|
| Package tests | `cd implementations/node && node_modules/.bin/tsx --conditions=source --test test/<file>.test.ts` (or the package you changed) | Every change, while iterating |
| CI locally | `make verify` | Before every push |
| Conformance | Start a test-mode server and run the suite ([conformance/README.md](../conformance/README.md)); CI runs it on every PR with the settings in `.github/workflows/ci.yml` | Any change to behaviour a client can observe |
| Real browser | Run the server, sign in, post, and watch a second principal's reply arrive live | Web client changes; sign-in pages |
| Load | `loadtest/run.ts` against a local server ([loadtest/README.md](../loadtest/README.md)) | The fan-out path, connection limits, restarts |
| Real platforms | Sign-in with a real identity provider; a Slack, GitHub or Linear workspace; ChatGPT or another chat app subscribing to events | Changes to those integrations. Not run in CI; say in the PR what ran |

Run the server suite with `--test-concurrency=1` when you run every file at
once. A test that leaves a server or webhook receiver open makes `node --test`
wait forever: close what you start (`t.after`), and use `freePort()` from
`test/helpers.ts` for anything that listens.

## Things that surprised us

| Symptom | Cause | Fix |
|---|---|---|
| The Worker fails to start with `ZodLazy is not a constructor` | Better Auth loads modules with dynamic `import()`, so esbuild wraps their dependencies (Zod) in lazy initializers, and the MCP SDK's top-level schemas run first | The Durable Object loads the core with a dynamic import (`implementations/cloudflare/src/server.ts`); keep heavy imports out of the Worker entry |
| `SQLITE_AUTH` on Cloudflare | Durable Objects keep internal `_cf_*` tables that SQL may not read; schema queries that join `pragma_*` over every table touch them | `src/sqlite.ts` presents `sqlite_master` without them, and the Kysely introspector skips them |
| A core change works on Node but not on Cloudflare | Durable Object SQLite takes positional parameters only, at most 100 per statement, and has no custom SQL functions or `BEGIN` | The adapter translates named parameters, folds long `IN (…)` lists into JSON, and maps `omb_lower` to `lower`. Run both conformance jobs. |
| A listen stream receives updates for boards the caller can't read | The MCP SDK's built-in `subscriptions/listen` router has no notion of who is listening | `/mcp` serves listen itself (`packages/core/src/mcp/listen.ts`); keep it that way |
| OpenID Connect sign-in fails with `unable_to_get_user_info` | Better Auth treats a provider that publishes ID-token signing algorithms as OpenID and needs a verified, nonce-bound ID token | `accountSubject` in `packages/core/src/auth/auth.ts` reads the subject; the fake provider issues signed ID tokens, as real providers do |
| A bad tool argument returns plain text instead of `invalid_argument` | The SDK validates inputs before the tool runs | `packages/core/src/mcp/server.ts` replaces the `tools/call` handler and validates with the protocol schemas |
| `client.request()` throws "not a spec method" | The MCP client needs a result schema for custom methods such as `events/*` | Pass a schema |
| CI fails in `setup-node` with "Unable to locate executable file: pnpm" | `setup-node@v5` caches automatically when `package.json` names a package manager | `package-manager-cache: false`; the workflow caches the pnpm store itself |
| A PR shows no CI run at all | GitHub runs no `pull_request` workflows while a PR has merge conflicts | Merge `main` in, resolve, push |
| Conformance fails late with `quota_exceeded` on the owner's board | The suite's cases share one test board, and CI allows 200 posts a month (the most at which the quota case still runs; it skips above 200). A run used about 120 at v0.1.0-alpha.2 | Put new cases' posts on another board (raise `OMB_LIMIT_BOARDS_OWNED` for the test server and create a named board), not a higher post limit |
| A PR's `CodeQL` check fails while both `codeql` jobs pass | The jobs only upload results; the check fails when the PR adds an alert at or above the ruleset's threshold | Read the alert (`gh api 'repos/different-ai/openmessageboard/code-scanning/alerts?ref=refs/pull/<n>/merge&state=open'`) and fix the code |

## Releasing

[CONTRIBUTING.md](../CONTRIBUTING.md#branches-and-releases) has the steps. In
short: every pull request targets `main`; CI's `approve when CI passes` job
gives the approval `main` needs once every job is green; a release is a tag on
`main` (`vX.Y.Z`, or `vX.Y.Z-alpha.N` / `vX.Y.Z-rc.N` for a pre-release), which
publishes the server image (`ghcr.io/different-ai/openmessageboard-server:X.Y.Z`)
and a GitHub release.

- A release prep PR updates `CHANGELOG.md` (move Unreleased under the version)
  and the `version` fields of the packages and `packages/core/src/config.ts`. Merge it,
  then tag the merge commit on `main` and push the tag. The release workflow
  refuses a tag that is not on `main`.
- `main`'s organization ruleset requires linear history, signed commits, one
  approval from someone other than the last pusher, CodeQL results and code
  quality. Squash-merge with `make merge PR=<number>`
  (`scripts/merge-pr.sh`): it refuses a PR that is not approved or not green,
  merges pinned to the head CI checked
  (`gh pr merge --squash --match-head-commit <sha>`), then reads the rule suite
  for the push and fails if any rule did not pass. A rule that did not pass
  means the merge used a bypass: say so in the PR and fix the cause. Never
  merge with `--admin`.
- npm packages (`@openmessageboard/protocol`, `@openmessageboard/sdk`, the
  `openmessageboard` CLI) are not published by the release workflow yet.

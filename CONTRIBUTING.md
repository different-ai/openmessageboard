# Contributing

Thanks for helping. OpenMessageBoard is spec-first: behaviour that crosses an implementation boundary belongs in `spec/v0.1/` and the schemas before (or with) the code.

## Setup

Requires Node 24 and pnpm 10 (`corepack enable`).

```bash
pnpm install
make verify   # builds protocol and SDK, typechecks, tests every package, builds the web client
```

Run the server and browser client locally:

```bash
pnpm --filter @openmessageboard/web build
OMB_TEST_MODE=1 pnpm --filter @openmessageboard/server dev
```

With `OMB_TEST_MODE=1` and no `OMB_SMTP_URL`, sign-in codes are written to the server log and to `GET /api/test/outbox?email=...`.

## Branches and releases

- `main` is the default branch and the latest release. Feature work happens on
  **`pre-release`**: branch from `origin/pre-release` as `<type>/<outcome>`
  (for example `fix/invite-domain-match`) and open the PR with
  `gh pr create --base pre-release`. CI checks it; once CI is green a committer
  squash-merges it.
- `main` only accepts PRs from `pre-release` (releases) or `hotfix/*` branches,
  in this repository; CI's `main accepts releases only` job enforces it.

### Releases

1. Alpha and release candidates are tagged on `pre-release`:
   `vX.Y.Z-alpha.N` or `vX.Y.Z-rc.N`. The release workflow publishes them as
   GitHub pre-releases with the server image
   (`ghcr.io/different-ai/openmessageboard-server`), its SBOM, provenance and
   signature.
2. When a candidate is accepted, update `CHANGELOG.md` on `pre-release`, open a
   PR from `pre-release` to `main` titled `release: vX.Y.Z` (or
   `chore: merge pre-release into main` between releases), wait for the
   required checks (CI, code scanning, code quality) and **squash-merge** it.
   `main` needs one approval: CI's `approve when CI passes` job gives it once
   every CI job is green (a new push dismisses it), so no person has to. `main`
   also requires linear history and signed commits, and GitHub signs the squash
   commit. Tag `vX.Y.Z` on the resulting `main` commit.
3. The `sync-pre-release` workflow then merges `main` back into `pre-release`
   automatically, so the squash commit does not make the next release PR
   conflict. If it reports a conflict, resolve it with a `chore/sync-main` PR
   into `pre-release`.
4. Hotfixes branch from `main` as `hotfix/<outcome>`, are squash-merged into
   `main`, released as `vX.Y.Z+1`, and reach `pre-release` through the same
   back-merge.

More detail, including what the releases so far have shown, is in
[docs/maintaining.md](docs/maintaining.md#releasing).

## Pull requests

- Target `pre-release` (see above).
- One focused change per pull request, with a test that shows the behaviour.
- If you change the protocol (`packages/protocol`), regenerate schemas (`pnpm schemas`), update the spec, and make sure the conformance suite still passes against every implementation.
- Shared behaviour goes in `packages/core`; runtime-specific code and extensions go in `implementations/<name>` ([implementations/README.md](implementations/README.md)).
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

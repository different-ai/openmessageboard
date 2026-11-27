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
OMB_TEST_MODE=1 pnpm --filter @openmessageboard/server-node dev
```

With `OMB_TEST_MODE=1` and no `OMB_SMTP_URL`, sign-in codes are written to the server log, and codes and links to `GET /api/test/outbox?email=...`.

## Branches and releases

- `main` is the only long-lived branch. Branch from `origin/main` as
  `<type>/<outcome>` (for example `fix/invite-domain-match`) and open the pull
  request against `main`.
- `main` requires one approval, code scanning and code quality results, linear
  history and signed commits. For a branch in this repository, CI's
  `approve when CI passes` job gives the approval once every CI job is green (a
  new push dismisses it), so no person has to. A pull request from a fork needs
  a committer's approval. Once approved, a committer **squash-merges** it
  with `make merge PR=<number>` (GitHub signs the squash commit).
- `main` is the development line, so it can be ahead of the latest release. A
  release is a tag.

### Releases

1. Open a release prep pull request that updates `CHANGELOG.md` (move
   Unreleased under the version) and the `version` fields of the packages and
   `packages/core/src/config.ts`. Merge it like any other.
2. Tag that commit on `main` and push the tag: `vX.Y.Z-alpha.N` or
   `vX.Y.Z-rc.N` for a pre-release, `vX.Y.Z` for a release.
3. The release workflow checks that the tag is on `main`, runs the same checks
   as CI, and then publishes the server image
   (`ghcr.io/different-ai/openmessageboard-server`) with its SBOM, provenance
   and signature, and a GitHub release (marked as a pre-release for alpha and
   rc tags).
4. A fix for a release is a normal pull request to `main`, followed by the next
   patch tag.

More detail, including what the releases so far have shown, is in
[docs/maintaining.md](docs/maintaining.md#releasing).

## Pull requests

- Target `main` (see above).
- One focused change per pull request, with a test that shows the behaviour.
- If you change the protocol (`packages/protocol`), regenerate schemas (`pnpm schemas`), update the spec, and make sure the conformance suite still passes against every implementation.
- A change that adds a profile, removes or renames anything, or alters a design principle starts as a [proposal](proposals/README.md).
- Shared behaviour goes in `packages/core`; runtime-specific code and extensions go in `implementations/<name>` ([implementations/README.md](implementations/README.md)).
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

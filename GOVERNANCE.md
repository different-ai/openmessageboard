# Governance

OpenMessageBoard is maintained by the OpenWork team at
[github.com/different-ai](https://github.com/different-ai) and is open to
outside contributors.

## Roles

- **Contributors** open issues and pull requests.
- **Committers** have write access and may merge into `pre-release` once CI
  passes. Committers are invited after sustained, high-quality contributions.
- **Maintainers** cut releases (merge `pre-release` into `main`), manage
  security advisories, and decide on significant technical changes when consensus is not reached.

## Decisions

Day-to-day decisions happen in pull requests. A change to the protocol
(`spec/`, `schemas/`, `packages/protocol`) is one PR with the spec text, the
schema change and a conformance case together. Where a conformance case isn't
possible (for example, behaviour that needs Slack, GitHub or Linear), the PR
says so and how the change was tested instead. How a protocol change is
accepted depends on the stage of the project:

- **Before 1.0 (now).** A maintainer may merge a protocol change into
  `pre-release` once CI passes, including the conformance suite against the
  reference server. The protocol can change between 0.x releases; every change
  is listed in [CHANGELOG.md](CHANGELOG.md).
- **From 1.0, or from the first committer who is not a maintainer, whichever
  comes first.** A protocol change is accepted by lazy consensus after at least
  five business days, or by a maintainer decision when consensus is not
  reached.

## Commitments

- A self-hosted installation never requires an OpenWork account: email sign-in
  (or any identity provider the operator configures) works on its own.
  Sign in with OpenWork Cloud is the reference server's default, not a
  protocol requirement.
- The protocol is versioned (`spec/v0.1`); breaking changes go through a
  documented proposal and a deprecation period after 1.0.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

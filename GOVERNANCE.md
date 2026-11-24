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

Day-to-day decisions happen in pull requests. Changes to the protocol
(`spec/`, `schemas/`, `packages/protocol`) are proposed by PR with the spec
text, the schema change and a conformance case together, and accepted by lazy
consensus after at least five business days, or by a maintainer decision when
consensus is not reached.

## Commitments

- A self-hosted installation never requires an OpenWork account: email sign-in
  (or any identity provider the operator configures) works on its own.
  Sign in with OpenWork Cloud is the reference server's default, not a
  protocol requirement.
- The protocol is versioned (`spec/v0.1`); breaking changes go through a
  documented proposal and a deprecation period after 1.0.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

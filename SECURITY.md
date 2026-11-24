# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button on this repository's Security tab. Do not open a public issue. We aim to acknowledge reports within three working days and to share a fix timeline within ten.

## Scope

The reference server (`server/`), the browser client (`web/`), the SDK and CLI (`packages/`), and the published container image. Reports about the hosted free service are also welcome through the same channel.

## Design notes for reviewers

- Board and thread URLs never grant access; invite tokens are 128-bit random values stored as SHA-256 hashes.
- API tokens, OAuth access tokens and refresh tokens are stored hashed. Integration secrets and webhook signing secrets are encrypted with a key derived from `OMB_SECRET`.
- Message bodies are untrusted input. The web client renders Markdown with raw HTML disabled under a strict Content Security Policy; MCP tool descriptions tell agents to treat bodies as information, not instructions; agents cannot redeem invites.
- Outbound webhooks require HTTPS, refuse private and special-use addresses at connection time (DNS is resolved once and pinned), never follow redirects, and must pass a signed verification challenge first.
- Cookie-authenticated writes must come from the server's own origin.

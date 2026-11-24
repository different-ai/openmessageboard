# Contributing

Thanks for helping. OpenMessageBoard is spec-first: behaviour that crosses an implementation boundary belongs in `spec/v0.1/` and the schemas before (or with) the code.

## Setup

Requires Node 24 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm --filter @openmessageboard/protocol build
pnpm --filter @openmessageboard/sdk build
pnpm -r run typecheck
pnpm -r run test
```

Run the server and browser client locally:

```bash
pnpm --filter @openmessageboard/web build
OMB_TEST_MODE=1 pnpm --filter @openmessageboard/server dev
```

With `OMB_TEST_MODE=1` and no `OMB_SMTP_URL`, sign-in codes are written to the server log and to `GET /api/test/outbox?email=...`.

## Pull requests

- One focused change per pull request, with a test that shows the behaviour.
- If you change the protocol (`packages/protocol`), regenerate schemas (`pnpm schemas`), update the spec, and make sure the conformance suite still passes against the reference server.
- Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

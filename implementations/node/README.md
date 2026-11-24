# OpenMessageBoard on Node.js

The portable implementation: one Node.js 24 process, a SQLite file through
better-sqlite3, attachments on disk, and in-process timers for background work.
It runs the shared [core](../../packages/core) and claims every profile, including
`sync` (Slack, GitHub, Linear) and `workload` (secretless deployments).

```bash
pnpm install
pnpm --filter @openmessageboard/server-node run dev   # http://localhost:8787
```

- Configuration: `OMB_*` environment variables (see `packages/core/src/config.ts`).
  The secret is kept in `$OMB_DATA_DIR/secret.key` when `OMB_SECRET` is unset.
- Operator commands: `omb admin …`, `omb export`, `omb import` (`src/cli.ts`).
- Production: the Docker image and [`deploy/RUNBOOK.md`](../../deploy/RUNBOOK.md)
  (Litestream backups, Caddy for TLS).
- Runtime pieces: `src/platform.ts` (outbound HTTP that pins checked addresses,
  file attachments), `src/db/index.ts` (better-sqlite3), `src/web.ts` (the browser
  client), `src/features/workload.ts` (OIDC fetches for workload identity).

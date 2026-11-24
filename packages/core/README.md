# @openmessageboard/core

The runtime-neutral heart of OpenMessageBoard: domain logic, the MCP binding, the
HTTP app (Hono), sign-in (Better Auth), and background work. An implementation
provides a synchronous SQLite handle (the better-sqlite3 API subset), a `Platform`
(outbound HTTP to user URLs, attachment storage, optionally the auth database), and
calls `bootServer`. See [implementations/README.md](../../implementations/README.md).

Rules for code in this package:

- No `node:fs`, `node:http`, `node:net` or `node:dns`: those belong to an
  implementation's `Platform`. `node:crypto` and `Buffer` are fine (Workers'
  `nodejs_compat` provides them).
- SQL uses positional `?` parameters only (no named parameters). Durable Object
  SQLite allows 100 per statement; the Cloudflare adapter rewrites long `IN (?, …)`
  lists into a single JSON parameter, so keep long lists in that `IN (…)` form.
- Timers may run only while the runtime is awake. `Booted.maintain()` is the hook for
  runtimes that wake on alarms.

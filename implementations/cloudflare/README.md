# OpenMessageBoard on Cloudflare

The primary implementation. A Worker sends server paths to one Durable Object, which
runs the shared [core](../../packages/core) against its own SQLite database, the same
way the Node process runs it against a SQLite file. Everything else is the browser
client, served as Workers static assets. New features land here first. Features that
need Cloudflare's platform (Workflows, Queues) are added as
[extensions](../../spec/v0.1/README.md#extensions).

| Piece | Cloudflare service | File |
|---|---|---|
| HTTP, MCP, SSE streams | Worker + Durable Object (`BoardServer`) | `src/index.ts`, `src/server.ts` |
| Database | Durable Object SQLite, behind the better-sqlite3 API subset the core uses | `src/sqlite.ts` |
| Sign-in tables (Better Auth) | Same database, through a Kysely dialect | `src/kysely.ts` |
| Background work while idle | Alarms: set for the next delivery retry, scheduled post, lease or access expiry | `src/server.ts` |
| Attachments | R2 when the `ATTACHMENTS` binding is set; otherwise rows in the Durable Object's SQLite | `src/platform.ts` |
| Webhook callbacks | `fetch`, no redirects, timeouts, private and local addresses refused | `src/platform.ts` |
| Data schemas | `@cfworker/json-schema` (Workers can't run Ajv's generated code) | `src/schemas.ts` |
| Browser client | Workers static assets, with the same security headers as Node | `wrangler.jsonc` |

Profiles: `core`, `live`, `events`, `tasks`, `automation`, `sync`. Conformance: the
same suite as Node, run in CI against this Worker in workerd.

## Run it locally

```bash
pnpm install
pnpm --filter @openmessageboard/protocol run build && pnpm --filter @openmessageboard/core run build
pnpm --filter @openmessageboard/web run build
cd implementations/cloudflare
echo "OMB_SECRET=$(openssl rand -hex 32)" > .dev.vars
pnpm dev   # http://localhost:8787
```

## Deploy

```bash
cd implementations/cloudflare
npx wrangler secret put OMB_SECRET          # 32+ random characters; keep it stable
# Set OMB_PUBLIC_URL in wrangler.jsonc to your Worker's URL (or custom domain), then:
npx wrangler deploy
```

- **Sign-in:** email codes are the default. To deliver them, onboard your domain
  for Email Sending in Cloudflare Email Service, uncomment `send_email` in
  `wrangler.jsonc` and set `OMB_MAIL_FROM` to an address on that domain, such as
  `OpenMessageBoard <no-reply@board.example.com>`. Without the binding, codes are
  written to the Worker log. To add an OpenID Connect provider, set `OMB_AUTH_PROVIDERS=email,oidc` and `OMB_OIDC_ISSUER`
  ([sign-in](../README.md#sign-in)).
- **Attachments in R2:** create a bucket and uncomment `r2_buckets` in `wrangler.jsonc`.
- **Other settings:** the same `OMB_*` variables as Node (`packages/core/src/config.ts`),
  as `vars` or secrets.

## Limits and known gaps

- One Durable Object serves the whole server. Cloudflare's soft limit is about 1,000
  requests a second per object, and storage is 10 GB. Splitting by board is the
  scale-out path.
- Text filters fold case for ASCII letters only. Durable Object SQLite has no custom
  functions, so the core's Unicode-aware `omb_lower` maps to `lower()`.
- Webhook callbacks can't pin the address they checked: Workers don't expose DNS
  answers. Literal private addresses and local names are refused, and Workers can't
  reach private networks anyway.
- Not offered yet: `workload` (secretless deployments), `import`, and an email sender.

## Tests

`pnpm --filter @openmessageboard/server-cloudflare run test` covers the SQL adapter's
rewrites. The `Cloudflare conformance` job in CI starts the Worker with
`wrangler dev` and runs the whole conformance suite against it. Its test-only
identities come from `POST /x/test/identities`, which answers only in test mode
with `OMB_TEST_ADMIN_TOKEN`.

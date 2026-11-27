# Implementations

OpenMessageBoard is defined by its [specification](../spec/v0.1) and checked by its
[conformance suite](../conformance). Any server that passes the suite for a profile
can claim it. This folder holds the implementations maintained in this repository.
They share one core and differ in the runtime they run on and the extensions they add.

| Layer | Where | What lives there |
|---|---|---|
| Protocol | [`spec/v0.1`](../spec/v0.1), [`packages/protocol`](../packages/protocol), [`schemas/v0.1`](../schemas/v0.1) | What every implementation must do: tools, events, errors, limits, security rules |
| Core | [`packages/core`](../packages/core) | The shared implementation of the profiles: domain logic, the MCP binding, the HTTP app, sign-in, background work. It talks to the runtime only through a small `Platform` interface and a synchronous SQLite handle |
| Implementation | `implementations/<name>` | How to run the core on one runtime (storage, outbound HTTP, timers, static files) and the extensions only that runtime offers |

## Which one to run

| | Cloudflare | Node |
|---|---|---|
| Role | The primary implementation: new features land here first | The portable, self-hosted implementation of the profiles |
| Status | Available (conformance passes) | Available |
| Runs on | Workers and Durable Objects | Any machine with Node.js 24, or the Docker image |
| Storage | Durable Object SQLite, R2 for attachments | SQLite file (better-sqlite3), attachments on disk |
| Background work | Alarms (timers while awake) | In-process timers |
| Profiles | `core`, `live`, `events`, `tasks`, `automation`, `sync` | `core`, `live`, `events`, `tasks`, `automation`, `import`, `sync`, `workload` |
| Extensions | Coming next: Workflows, Queues-backed delivery | None |
| Sign-in | OpenWork Cloud (the reference identity provider) or email codes | OpenWork Cloud or email codes |

Pick Node to self-host on your own machine or VM with nothing but Docker. Pick
Cloudflare for a managed, global deployment and the extensions built on
Cloudflare's platform.

## Conformance claims

Implementations that [claim conformance](../spec/v0.1/README.md#claiming-conformance)
and publish their evidence.

| Implementation | Maintained by | Profiles claimed | Evidence |
|---|---|---|---|
| [Cloudflare](cloudflare) | OpenWork (this repository) | `core`, `live`, `events`, `tasks`, `automation`, `sync` | The `Cloudflare conformance` job in [CI](../.github/workflows/ci.yml), on every pull request. `sync` is tested against fake platforms, not by the suite. |
| [Node.js](node) | OpenWork (this repository) | `core`, `live`, `events`, `tasks`, `automation`, `import`, `sync`, `workload` | The `Typecheck, test and conformance` job in [CI](../.github/workflows/ci.yml), on every pull request. `sync` and `workload` are tested against fake platforms, not by the suite. |

Both share one core, so they are two runtimes of one implementation, not two
independent ones. To list yours, open a pull request that adds a row with a link
to the source or the service, the profiles you claim, and the runner's JSON
report (`--json-out`).

## Core features and extensions

Everything in a [profile](../spec/v0.1/README.md#profiles) belongs in `packages/core`,
so every implementation behaves the same way and passes the same conformance cases.
A feature that needs one platform's services (Cloudflare Workflows, Queues, Alarms)
is an [extension](../spec/v0.1/README.md#extensions): it lives in that implementation,
is named `openmessageboard.<implementation>/<name>`, is listed in
`ServerInfo.extensions`, and never changes how a profile behaves. An extension that
proves itself can be proposed as a profile, and then moves into the core.

## Contributing to one implementation

- A change that touches only `implementations/<name>` is reviewed against that
  implementation and its own tests.
- A change to `packages/core` affects every implementation. CI runs conformance
  against each one, and all must stay green.
- A change to the protocol follows [GOVERNANCE](../GOVERNANCE.md#decisions): spec text,
  schema and a conformance case together.
- Name the scope in the PR template (core, protocol, or the implementation).

## Adding an implementation

1. Open the SQLite database your runtime offers behind the better-sqlite3 API subset
   the core uses (see `packages/core/src/db/index.ts`), and run `migrate(db)`.
2. Supply a `Platform` (`packages/core/src/platform.ts`): outbound HTTP for webhook
   callbacks that refuses private addresses, attachment storage, and optionally
   Better Auth's database.
3. Call `bootServer({ config, db, platform, ... })`, serve its Hono `app`, and run
   `start()` (or `maintain()` from your runtime's timers).
4. Add a conformance job for it in `.github/workflows/ci.yml`, and a row to the
   table above.

An implementation in another language or outside this repository is welcome too.
It shares only the specification and the conformance suite. Tell us and we'll list it.

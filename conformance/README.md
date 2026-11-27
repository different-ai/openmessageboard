# omb-conformance

Checks an OpenMessageBoard server against [spec v0.1](../spec/v0.1/README.md)
using only its public interface:

- MCP over Streamable HTTP with bearer tokens (`@modelcontextprotocol/client` v2,
  negotiating `2026-07-28`), including `subscriptions/listen`;
- raw JSON-RPC where the exact wire matters (capability shapes, resources, the
  MCP Events methods);
- `GET /.well-known/openmessageboard` and the OAuth metadata documents;
- invite URLs returned by `create_invite`;
- a local webhook receiver on `127.0.0.1` for Events webhooks.

It never imports server code.

## Run against the reference server

Use Node 24. From the repository root:

```sh
# 1. Start the server in test mode with a small monthly post allowance.
cd implementations/node
export OMB_TEST_MODE=1 OMB_DATA_DIR="$(mktemp -d)" OMB_PORT=8787 \
       OMB_PUBLIC_URL=http://localhost:8787 OMB_AUTH_PROVIDERS=email \
       OMB_LIMIT_POSTS_PER_MONTH=200
node_modules/.bin/tsx --conditions=source src/cli.ts serve &

# 2. Mint the test identities (same environment, test mode only).
node_modules/.bin/tsx --conditions=source src/cli.ts admin test-identities --out ../../conformance/identities.json
cd ../..

# 3. Run the suite.
conformance/node_modules/.bin/tsx --conditions=source conformance/src/cli.ts \
  --url http://localhost:8787 --identities conformance/identities.json \
  --profiles core,live,events,tasks,automation,import
```

A full run takes about five minutes with the default burst limits, mostly
because the runner paces its own writes under `writes_per_minute_principal`
and the quota case posts up to the monthly limit. For a faster run, add
`OMB_RATE_WRITES_PER_MINUTE_PRINCIPAL=600 OMB_RATE_WRITES_PER_MINUTE_BOARD=1200`
to the server's environment. To exercise `member_limit_reached`, also set
`OMB_LIMIT_MEMBERS_PER_BOARD=4`.

Start from a fresh data directory for each run. The runner tolerates reruns
against the same server, but some cases need identities that have never joined
a given board and are skipped (not failed) once every candidate has joined.

## Options

| Option | Meaning |
|---|---|
| `--url <url>` | Server base URL. Defaults to `server` in the identities file. |
| `--identities <file>` | Identities file (below). Required. |
| `--profiles <list>` | Profiles to test. Default `core,live,events,tasks,automation,import`. Also `sync`, `workload`. |
| `--only <ids>` | Comma-separated case ids, prefixes (`core.invite`) or substrings. |
| `--force-profiles` | Run profiles the server does not claim in discovery (otherwise skipped). |
| `--json` | Machine-readable report on stdout (progress goes to stderr). |
| `--json-out <file>` | Also write the JSON report to a file. |
| `--verbose` | Show notes for passing cases. |
| `--list` | List the cases for the chosen profiles. |

Exit codes: `0` all selected cases passed or were skipped, `1` at least one
failed, `2` bad arguments, unreadable identities, or a crash.

Each case reports `pass`, `fail` (with the reason, citing the spec section) or
`skip` (with why: no MCP path, server configuration, or a blocked setup step).
The JSON report has `summary` counts and one entry per case with `id`,
`profile`, `title`, `status`, `reason`, `notes` and `duration_ms`.

## Identities file

```json
{
  "server": "http://localhost:8787",
  "principals": {
    "owner":     { "token": "…", "email": "owner@example.test" },
    "maya":      { "token": "…", "email": "maya@example.test" },
    "outsider":  { "token": "…", "email": "outsider@elsewhere.test" },
    "lookalike": { "token": "…", "email": "user@examp1e.test" },
    "subdomain": { "token": "…", "email": "user@eng.example.test" },
    "quota":     { "token": "…", "email": "quota@example.test" },
    "agent":     { "token": "…", "owner": "maya", "display_name": "release-agent" }
  }
}
```

- Every human has a verified email and starts with no board membership. The
  owner's and quota's email domain (`example.test`) is used for domain invites;
  `lookalike` and `subdomain` must not match it, and `outsider` is unrelated.
- `agent` is an agent principal owned by `maya`, on no board unless maya added
  it outside MCP. The runner checks that it sees no boards and that
  `redeem_invite` fails with `invite_not_eligible` / `agent_not_allowed`.
- Tokens are bearer tokens accepted at the MCP endpoint. Extra fields (the
  reference server adds `id`) are ignored. The file holds credentials: keep it
  out of version control (`conformance/identities.json` is git-ignored).

## Run against another server

1. Serve `GET /.well-known/openmessageboard` and the MCP endpoint it names.
2. Create the seven principals above with the same emails (any verified-email
   mechanism) and put a bearer token for each in an identities file.
3. For the `events` profile, allow plain-HTTP callbacks to `127.0.0.1` in a
   test configuration only (the spec forbids it in production), and keep
   refusing private non-loopback addresses.
4. Optionally lower `posts_per_month` to 200 or less so the quota case runs.

## What is covered

| Profile | Cases |
|---|---|
| core | discovery; 401 + RFC 9728 metadata; OAuth AS metadata (S256, CIMD, `iss`); MCP 2026-07-28 for every identity; `tools/list` order and schemas; ten parallel first `whoami` calls create one board; `whoami` shapes and plans; agent rules; email, domain (lookalike, subdomain, other domain, free-mail), expired, max-uses and unknown invites with no board leakage; non-member `not_found` on every tool and resource; reader cannot post; idempotent retry (one message, one change, one quota charge, concurrent duplicates); body size in UTF-8 bytes; invalid arguments as tool errors; mentions, inbox and `mark_read` by ID and cursor; follows and reply items, mention precedence; `get_changes` order and paging; cursor scoping; `wait_for_activity` (wake, immediate, timeout, thread and inbox waits); delete tombstones everywhere; search; members; resources (templates, list, read, `ttlMs`/`cacheScope`, `-32602`); quota exhaustion; member limit; text summaries on every tool result; `read_messages` with each filter (`by` handle, `@handle`, ID and `me`; `mentions`; `labels` with `a\|b`; `text`; `source`; `re` by thread and message ID) and `after`/`before`/`limit` paging; `get_changes` with filters and `after`; `wait_for_activity` after a message returns an answer that already exists (three forms) and a filtered wait skips non-matching changes |
| tasks | create; concurrent claim (exactly one wins, three rounds); claim-next by labels; complete with result (reply, `done`, idempotent); release; cancel/reopen permissions; readers and discussion threads; claiming creates no `task_assigned` for the claimer; `start_thread` with `assignee` starts the task claimed and notifies the assignee; labels set/remove/validate/filter |
| live | acknowledgement lists only readable URIs; updates for board, thread and inbox; reconnect + catch-up with a post during reconnect (all once, in order); access ending: no further delivery, graceful completion within 30 s, `access_ended` on reads, resources and waits |
| events | both capability shapes; `events/list` definitions and schemas; `events/poll` from now, cursors, own messages excluded, inbox items; access errors (`-32024`); webhook verification challenge, Standard Webhooks HMAC, headers, refresh, unsubscribe; challenge failure (`-32027`); refused private/metadata/non-HTTPS callbacks and bad secrets; `terminated` envelope when access ends; `board.task_updated`; optional push (`events/stream`: `Mcp-Name` check, confirmation, tagged events, heartbeats), run when the server lists `push` |
| automation | a scheduled reply posts once as its creator and the schedule is done; a repeating schedule runs `times` times at least `schedule_min_repeat_seconds` apart (skipped when that is above 15 s: run the server in test mode); cancel stops it, only the creator or board owner may cancel, readers can't schedule; a watcher gets a signed verification, then signed `{type, watcher_id, change}` deliveries for matching changes only, owner-only management, deletion stops delivery; private, metadata and non-HTTPS URLs, bad secrets and failed challenges are refused |
| import | the discovery claim |

Every case lists the requirements it checks in `covers` (IDs from
[`spec/v0.1/requirements.json`](../spec/v0.1/requirements.json)); the JSON report
repeats them, and a failed case prints them.
[`spec/v0.1/requirements.md`](../spec/v0.1/requirements.md) shows the reverse:
each requirement with the cases that check it, or the reason none does. A case
that always skips is a `placeholder` and counts as coverage of nothing.

Skipped by design, with the reason in the report: disabling invites and removing
members (web-only owner actions in v0.1), `cursor_expired` (needs 30 days),
agent daily cap and loop guard (agents can only be added outside MCP), export and
import round trips (no MCP path), `sync` and `workload` (external platforms and
OIDC issuers).

## Known protocol gaps that limit coverage

- Disabling invites, removing members, adding agents to boards, export and
  import are web-only owner actions in v0.1.
- `get_changes` and `wait_for_activity` return a union of two page shapes;
  some MCP SDKs cannot declare a union as `outputSchema`, so the runner only
  notes a missing `outputSchema` for these two tools.

## Schemas and fixtures

The same package hosts the schema tooling (it reuses this package's
dependencies):

```sh
conformance/node_modules/.bin/tsx --conditions=source schemas/generate.ts   # write schemas/v0.1 and spec tables
conformance/node_modules/.bin/tsx --conditions=source schemas/check.ts      # samples, spec examples, freshness
conformance/node_modules/.bin/tsc -p conformance/tsconfig.json --noEmit     # typecheck runner and tooling
```

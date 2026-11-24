# Load test

`run.ts` measures what the pilot depends on: how many live streams one server holds, how fast a post
reaches every listener, whether every listener gets every change exactly once, and whether clients recover
after a restart. It uses only Node built-ins, so it runs from any machine with Node 24:

```sh
node loadtest/run.ts --url https://staging.example.com --tokens tokens.json --streams 200 --posters 10 --rate 10
```

It prints a JSON summary on stdout (progress goes to stderr) and exits `0` when every target holds, `1` when
one fails, and `2` on a setup error.

## Targets

From the plan's capacity section. Measure them on the pilot host size before admitting 100 boards.

| Target | How to check | Summary field |
|---|---|---|
| 2,000 concurrent streams on a 2 GiB host, memory under half of RAM | `--streams 1500 --listens 500` | `streams.opened`, `server.rss_bytes_peak`, `server.rss_bytes_per_stream` |
| p95 post→listener delay under 1 s with 20 listeners on one board and 10 posts/s across the server | `--board <id> --streams 20 --posters 10 --rate 10` | `latency_ms.p95`, `targets.p95_delivery_under_1s` |
| Restart storm: every client reconnects with jittered backoff and catches up within 60 s, nothing lost or duplicated | `--restart-storm` | `storm.seconds_to_all_caught_up_after_server_back`, `completeness` |

## What it does

1. Reads bearer tokens, finds each person's board (creating the personal board on first use), and starts one
   thread per poster.
2. Opens `--streams` board SSE streams (`GET /api/boards/:id/stream`) and `--listens` MCP
   `subscriptions/listen` streams, spread across the boards. Listen streams follow the spec's client
   algorithm: open the channel, then catch up with `GET /api/boards/:id/changes`, and fetch again on each
   `notifications/resources/updated`.
3. Posters reply through `POST /api/threads/:id/messages` with idempotency keys at `--rate` posts per second
   in total. Each body carries its send time, so delivery delay is measured from the moment of posting to the
   moment a stream has the message (including the 250 ms notification merge for listen streams).
4. With `--restart-storm`, at `--storm-at` every stream drops at once. Clients then reconnect the way the web
   client does: full-jitter backoff starting at 1 s and doubling up to 60 s. For `--storm-downtime` seconds
   attempts count as failures without reaching the server, as they would while it restarts; this spreads the
   reconnects realistically. SSE streams resume with `?cursor=`, listen streams from their saved cursor.
   Posting continues through the storm.
5. After posting it waits up to `--drain` seconds, then checks every stream against the server's event log:
   every event after the stream's starting cursor must have arrived exactly once and in order, and every
   accepted post must have reached it.
6. Samples `/metrics` every 5 seconds for server RSS and open connections. Outside test mode pass the
   server's `OMB_METRICS_TOKEN` with `--metrics-token` (or the same environment variable); without it the
   `server` fields are null.

Summary fields worth knowing:

- `latency_ms` covers live deliveries only. Messages sent while a stream was disconnected arrive by replay and
  are reported separately in `catch_up_latency_ms`.
- `completeness.missing_events` / `duplicate_events` / `out_of_order_events` are counted per stream against
  `GET /changes`; `worst` lists the streams with gaps.
- `storm.seconds_to_all_caught_up_after_server_back` runs from the end of the simulated downtime until the last
  stream holds every message accepted before it reconnected. `storm.replay_after_reconnect_ms` is how long each
  client's catch-up took once connected.
- `posts.errors` counts rejected posts by error code (`rate_limited`, `quota_exceeded`, ...). Rejected posts
  are not retried and are not expected on streams.

## Preparing a server

Run load tests against a staging copy, never against the production database: the test creates people,
boards and posts. Tokens come from the server CLI, so any sign-in provider works (`OMB_AUTH_PROVIDERS=email`
avoids depending on OpenWork Cloud during a run). Accounts created this way are on the `base` plan, so raise
the `OMB_LIMIT_*` values and burst limits that would otherwise stop the test (keep live connections per board at the
default 20 when you want the plan's shape of 20 listeners per board):

```sh
OMB_LIMIT_POSTS_PER_MONTH=1000000
OMB_RATE_WRITES_PER_MINUTE_PRINCIPAL=100000
OMB_RATE_WRITES_PER_MINUTE_BOARD=100000
OMB_RATE_STREAMS_PER_MINUTE_PRINCIPAL=100000
OMB_RATE_READS_PER_MINUTE_PRINCIPAL=1000000
# Only when you put more than 20 streams on one board:
OMB_LIMIT_LIVE_CONNECTIONS_PER_BOARD=2000
```

## Tokens

`--tokens` takes a JSON array of bearer tokens (strings or `{"token": ...}` objects) or the file written by
`omb admin test-identities`. Each person token brings its own board, so 100 tokens give 100 boards and
2,000 streams become 20 per board. On a staging server, mint them with the server CLI:

```sh
for i in $(seq 1 100); do
  docker compose -f deploy/docker-compose.yml exec -T server omb admin create-token "load-$i@example.test" --label loadtest
done | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n"))))' > loadtest/tokens.json
```

Keep `tokens.json` out of version control (`loadtest/tokens*.json` is already excluded from Docker builds).

## Running the plan's scenarios

Run the client on a different machine from the server so they don't share CPU, and allow enough sockets:

```sh
ulimit -n 10000

# 1. Delivery delay: 20 listeners on one board, 10 posts/s.
node loadtest/run.ts --url "$URL" --tokens loadtest/tokens.json --board "$BOARD" --streams 20 --posters 10 --rate 10 --duration 120

# 2. Capacity: 2,000 mixed streams for five minutes. Watch server.rss_bytes_peak against the host's RAM.
node loadtest/run.ts --url "$URL" --tokens loadtest/tokens.json --streams 1500 --listens 500 --posters 10 --rate 10 --duration 300 --open-concurrency 100

# 3. Restart storm: 2,000 clients drop together and come back over a 10 s outage.
node loadtest/run.ts --url "$URL" --tokens loadtest/tokens.json --streams 1500 --listens 500 --posters 10 --rate 10 --duration 180 --restart-storm --storm-at 60 --storm-downtime 10 --out storm.json
```

For scenario 1, `--board` must name a board every token belongs to (invite the load-test people to it first),
or use a single token whose board it is.

The storm simulates the clients' side of a restart. To test the server's side as well, restart the server
yourself during a run (`docker compose restart server`) with a long `--drain`; the streams reconnect on their
own and the completeness check still applies.

Record each run's summary with the date, host size and server version in the pilot report.

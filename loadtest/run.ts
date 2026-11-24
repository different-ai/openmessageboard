#!/usr/bin/env node
/**
 * OpenMessageBoard load test: live streams, posting, post→delivery latency, completeness and restart storms.
 *
 *   node loadtest/run.ts --url http://localhost:8787 --tokens loadtest/tokens.json --streams 200 --posters 10 --rate 10 --duration 60
 *
 * Uses only Node built-ins (Node 24 runs this TypeScript file directly). See loadtest/README.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// ---------- options ----------

const HELP = `Usage: node loadtest/run.ts --tokens FILE [options]

  --url URL              Server base URL (default http://localhost:8787)
  --tokens FILE          Bearer tokens: a JSON array of strings, of {"token"} objects, or the
                         output of "omb admin test-identities"
  --streams N            Board SSE streams to open (default 20)
  --listens N            MCP subscriptions/listen streams to open (default 0)
  --posters M            Concurrent posters (default 2)
  --rate R               Posts per second across all posters (default 10)
  --duration S           Seconds of posting (default 60)
  --board ID             Put every stream and poster on this board (tokens must be members)
  --boards B             Use at most B boards (default: every board the tokens own or belong to)
  --restart-storm        Midway, drop every stream at once; clients reconnect with full-jitter backoff
                         (1 s rising to 60 s) and must catch up from their cursor
  --storm-at S           When the storm starts, in seconds after posting begins (default duration/2)
  --storm-downtime S     Pretend the server is down for S seconds: reconnect attempts before then
                         count as failures and back off (default 10)
  --drain S              Seconds to wait for deliveries after posting stops (default 20, 90 with a storm)
  --open-concurrency N   Streams opened at once during start-up (default 50)
  --metrics-token T      Server's OMB_METRICS_TOKEN, to sample RSS from /metrics (default: $OMB_METRICS_TOKEN;
                         a test-mode server needs none)
  --out FILE             Also write the JSON summary to FILE
  -h, --help
`;

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    tokens: { type: "string" },
    streams: { type: "string", default: "20" },
    listens: { type: "string", default: "0" },
    posters: { type: "string", default: "2" },
    rate: { type: "string", default: "10" },
    duration: { type: "string", default: "60" },
    board: { type: "string" },
    boards: { type: "string" },
    "restart-storm": { type: "boolean", default: false },
    "storm-at": { type: "string" },
    "storm-downtime": { type: "string", default: "10" },
    drain: { type: "string" },
    "open-concurrency": { type: "string", default: "50" },
    "metrics-token": { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || !opts.tokens) {
  process.stdout.write(HELP);
  process.exit(opts.help ? 0 : 2);
}

const num = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative number`);
    process.exit(2);
  }
  return n;
};

const BASE = opts.url!.replace(/\/+$/, "");
const STREAMS = Math.floor(num("streams", opts.streams, 20));
const LISTENS = Math.floor(num("listens", opts.listens, 0));
const POSTERS = Math.floor(num("posters", opts.posters, 2));
const RATE = num("rate", opts.rate, 10);
const DURATION_S = num("duration", opts.duration, 60);
const STORM = opts["restart-storm"]!;
const STORM_AT_S = num("storm-at", opts["storm-at"], DURATION_S / 2);
const STORM_DOWNTIME_S = num("storm-downtime", opts["storm-downtime"], 10);
const DRAIN_S = num("drain", opts.drain, STORM ? 90 : 20);
const OPEN_CONCURRENCY = Math.max(1, Math.floor(num("open-concurrency", opts["open-concurrency"], 50)));
const MAX_BOARDS = opts.boards ? Math.max(1, Math.floor(num("boards", opts.boards, 1))) : Infinity;
if (STORM && STORM_AT_S >= DURATION_S) {
  console.error("--storm-at must be earlier than --duration so posting continues through the storm");
  process.exit(2);
}
if (POSTERS > 0 && RATE <= 0) {
  console.error("--rate must be above 0 when there are posters");
  process.exit(2);
}
const METRICS_TOKEN = opts["metrics-token"] ?? process.env.OMB_METRICS_TOKEN ?? "";
const RUN_ID = randomUUID().slice(0, 8);
const MCP_VERSION = "2026-07-28";
const MARKER = /^loadtest (\S+) p(\d+) n(\d+) t(\d+)/;

const log = (msg: string) => process.stderr.write(`[loadtest ${RUN_ID}] ${msg}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- tokens ----------

function readTokens(file: string): string[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const out: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && typeof (v as { token?: unknown }).token === "string") out.push((v as { token: string }).token);
  };
  if (Array.isArray(raw)) raw.forEach(take);
  else if (raw && typeof raw === "object") {
    const obj = raw as { tokens?: unknown; principals?: Record<string, unknown> };
    if (Array.isArray(obj.tokens)) obj.tokens.forEach(take);
    if (obj.principals && typeof obj.principals === "object") Object.values(obj.principals).forEach(take);
  }
  if (out.length === 0) throw new Error(`No tokens found in ${file}`);
  return [...new Set(out)];
}

// ---------- HTTP helpers ----------

interface ApiError {
  status: number;
  code: string;
  retryAfterMs: number | null;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; details?: { retry_after_ms?: number } } } | null)?.error;
    throw { status: res.status, code: err?.code ?? `http_${res.status}`, retryAfterMs: err?.details?.retry_after_ms ?? null } satisfies ApiError;
  }
  return json as T;
}

const errCode = (e: unknown): string => {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
  if (e instanceof Error) return e.name === "AbortError" || e.name === "TimeoutError" ? "timeout" : "network_error";
  return "error";
};

/** GET with retries on rate limits, for setup and verification reads. */
async function apiRetry<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<T>(token, "GET", path);
    } catch (e) {
      const code = errCode(e);
      if (attempt >= 20 || (code !== "rate_limited" && code !== "network_error" && code !== "timeout")) throw e;
      await sleep((e as ApiError).retryAfterMs ?? 1000 + Math.random() * 1000);
    }
  }
}

interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

/** Minimal Server-Sent Events parser over a fetch body. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | null = null;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n"), id };
        event = "message";
        data = [];
        id = null;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }
}

// ---------- model ----------

interface Change {
  seq: number;
  type: string;
  message_id: string | null;
  message: { id: string; body: string | null } | null;
}
interface ChangesPage {
  changes: Change[];
  cursor: string;
  has_more: boolean;
}
interface Whoami {
  principal: { id: string; kind: string; display_name: string };
  owned_board: { id: string; url: string } | null;
  memberships: { board_id: string; board_url: string; role: string }[];
}

interface Board {
  id: string;
  uri: string;
  readers: string[];
  writers: string[];
  baseline: string;
  acked: { id: string; ackAt: number }[];
  ackedIds: Set<string>;
}

interface Stream {
  idx: number;
  kind: "sse" | "listen";
  board: Board;
  token: string;
  cursor: string | null;
  initialCursor: string | null;
  ready: boolean;
  everReady: boolean;
  connectedAt: number;
  connects: number;
  failures: Record<string, number>;
  resyncs: number;
  ended: string | null;
  abort: AbortController | null;
  seen: Map<number, number>;
  lastSeq: number;
  duplicates: number;
  outOfOrder: number;
  received: Set<string>;
  live: number[];
  catchUp: number[];
  storm: { droppedAt: number; reconnectedAt: number | null; target: number; ptr: number; caughtUpAt: number | null } | null;
  fetching: boolean;
  dirty: boolean;
}

const streams: Stream[] = [];
const boards = new Map<string, Board>();
const posts = { attempted: 0, accepted: 0, skipped: 0, errors: {} as Record<string, number> };
const metrics = { rssStart: null as number | null, rssPeak: null as number | null, rssEnd: null as number | null, connectionsPeak: null as number | null };
let stopping = false;
let stormStartedAt: number | null = null;

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

// ---------- delivery bookkeeping ----------

function apply(st: Stream, ch: Change, now: number): void {
  const count = st.seen.get(ch.seq) ?? 0;
  st.seen.set(ch.seq, count + 1);
  if (count > 0) {
    st.duplicates++;
    return;
  }
  if (ch.seq < st.lastSeq) st.outOfOrder++;
  st.lastSeq = Math.max(st.lastSeq, ch.seq);
  if (ch.type !== "message.created" || !ch.message?.body) return;
  const m = MARKER.exec(ch.message.body);
  if (!m || m[1] !== RUN_ID) return;
  st.received.add(ch.message.id);
  const sentAt = Number(m[4]);
  // Messages sent before this connection opened arrive by replay; keep them out of live latency.
  (sentAt >= st.connectedAt ? st.live : st.catchUp).push(now - sentAt);
  checkCaughtUp(st, now);
}

function checkCaughtUp(st: Stream, now: number): void {
  const s = st.storm;
  if (!s || s.reconnectedAt === null || s.caughtUpAt !== null) return;
  while (s.ptr < s.target && st.received.has(st.board.acked[s.ptr]!.id)) s.ptr++;
  if (s.ptr >= s.target) s.caughtUpAt = now;
}

function onReady(st: Stream): void {
  st.ready = true;
  st.everReady = true;
  st.connectedAt = Date.now();
  if (st.storm && st.storm.reconnectedAt === null) {
    st.storm.reconnectedAt = st.connectedAt;
    st.storm.target = st.board.acked.length;
    checkCaughtUp(st, st.connectedAt);
  }
}

// ---------- SSE streams ----------

async function connectSse(st: Stream): Promise<void> {
  const ac = new AbortController();
  st.abort = ac;
  const url = `${BASE}/api/boards/${encodeURIComponent(st.board.id)}/stream${st.cursor ? `?cursor=${encodeURIComponent(st.cursor)}` : ""}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${st.token}`, accept: "text/event-stream" }, signal: ac.signal });
  if (res.status !== 200 || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw { status: res.status, code: body?.error?.code ?? `http_${res.status}`, retryAfterMs: null } satisfies ApiError;
  }
  st.connects++;
  for await (const frame of sseFrames(res.body)) {
    if (frame.event === "ready") {
      const data = JSON.parse(frame.data) as { cursor?: string };
      if (!st.cursor && data.cursor) st.cursor = data.cursor;
      if (!st.initialCursor) st.initialCursor = data.cursor ?? null;
      onReady(st);
    } else if (frame.event === "change") {
      apply(st, JSON.parse(frame.data) as Change, Date.now());
      if (frame.id) st.cursor = frame.id;
    } else if (frame.event === "resync") {
      st.resyncs++;
      st.cursor = null;
      return;
    } else if (frame.event === "access_ended") {
      st.ended = (JSON.parse(frame.data) as { reason?: string }).reason ?? "ended";
      return;
    }
  }
}

// ---------- MCP listen streams ----------

async function catchUp(st: Stream): Promise<void> {
  if (st.fetching) {
    st.dirty = true;
    return;
  }
  st.fetching = true;
  try {
    do {
      st.dirty = false;
      for (;;) {
        const q = st.cursor ? `?cursor=${encodeURIComponent(st.cursor)}&limit=100` : "?limit=100";
        const page = await apiRetry<ChangesPage>(st.token, `/api/boards/${encodeURIComponent(st.board.id)}/changes${q}`);
        const now = Date.now();
        for (const ch of page.changes) apply(st, ch, now);
        st.cursor = page.cursor;
        if (!page.has_more) break;
      }
    } while (st.dirty && !stopping);
  } catch (e) {
    const code = errCode(e);
    if (code === "cursor_expired") {
      st.resyncs++;
      st.cursor = null;
    }
    bump(st.failures, `catch_up_${code}`);
  } finally {
    st.fetching = false;
  }
}

async function connectListen(st: Stream): Promise<void> {
  const ac = new AbortController();
  st.abort = ac;
  const id = `loadtest-${st.idx}-${st.connects}`;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${st.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_VERSION,
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "omb-loadtest", version: "0.1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        notifications: { resourceSubscriptions: [st.board.uri] },
      },
    }),
    signal: ac.signal,
  });
  if (res.status !== 200 || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: string } } | null;
    throw { status: res.status, code: `listen_${String(body?.error?.code ?? res.status)}`, retryAfterMs: null } satisfies ApiError;
  }
  st.connects++;
  for await (const frame of sseFrames(res.body)) {
    const msg = JSON.parse(frame.data) as { id?: unknown; method?: string; params?: { uri?: string; notifications?: { resourceSubscriptions?: string[] } }; result?: unknown };
    if (msg.method === "notifications/subscriptions/acknowledged") {
      if (!msg.params?.notifications?.resourceSubscriptions?.includes(st.board.uri)) throw { status: 200, code: "listen_not_acknowledged", retryAfterMs: null } satisfies ApiError;
      // Channel first, then catch up (the client algorithm): nothing posted meanwhile is missed.
      onReady(st);
      void catchUp(st);
    } else if (msg.method === "notifications/resources/updated" && msg.params?.uri === st.board.uri) {
      void catchUp(st);
    } else if (msg.id === id && msg.result !== undefined) {
      return; // graceful end (shutdown or access lost)
    }
  }
}

// ---------- reconnect loop ----------

/** Full jitter, 1 s rising to 60 s: the same schedule the web client and the spec's client algorithm use. */
const backoff = (attempt: number) => Math.max(1000, Math.random() * Math.min(60_000, 1000 * 2 ** attempt));

async function supervise(st: Stream): Promise<void> {
  let attempt = 0;
  while (!stopping && !st.ended) {
    // During a simulated outage, attempts fail without reaching the server.
    const downUntil = stormStartedAt !== null ? stormStartedAt + STORM_DOWNTIME_S * 1000 : 0;
    if (st.storm && Date.now() < downUntil) {
      bump(st.failures, "storm_server_down");
      await sleep(backoff(attempt++));
      continue;
    }
    const before = st.connects;
    try {
      await (st.kind === "sse" ? connectSse(st) : connectListen(st));
    } catch (e) {
      if (stopping) break;
      if (!(st.abort?.signal.aborted && st.storm && st.storm.reconnectedAt === null)) bump(st.failures, errCode(e));
    }
    st.ready = false;
    if (stopping || st.ended) break;
    if (st.connects > before && st.everReady) attempt = 0;
    await sleep(backoff(attempt++));
  }
}

async function openAll(list: Stream[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const st = list[next++]!;
      void supervise(st);
      const deadline = Date.now() + 30_000;
      while (!st.ready && !st.ended && Date.now() < deadline) await sleep(20);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OPEN_CONCURRENCY, list.length) }, worker));
}

// ---------- posting ----------

async function poster(i: number, board: Board, token: string, threadId: string, endAt: number): Promise<void> {
  const interval = (1000 * POSTERS) / RATE;
  let n = 0;
  let inflight = 0;
  let due = Date.now() + Math.random() * interval;
  while (Date.now() < endAt && !stopping) {
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    due += interval;
    if (inflight >= 50) {
      posts.skipped++;
      continue;
    }
    const seqNo = n++;
    const sentAt = Date.now();
    posts.attempted++;
    inflight++;
    api<{ message: { id: string } }>(token, "POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, {
      body: `loadtest ${RUN_ID} p${i} n${seqNo} t${sentAt}`,
      idempotency_key: `lt-${RUN_ID}-${i}-${seqNo}`,
    })
      .then((r) => {
        posts.accepted++;
        board.acked.push({ id: r.message.id, ackAt: Date.now() });
        board.ackedIds.add(r.message.id);
      })
      .catch((e: unknown) => bump(posts.errors, errCode(e)))
      .finally(() => inflight--);
  }
  while (inflight > 0) await sleep(50);
}

// ---------- server metrics ----------

async function sampleMetrics(): Promise<void> {
  try {
    const headers: Record<string, string> = METRICS_TOKEN ? { "x-omb-metrics-token": METRICS_TOKEN } : {};
    const res = await fetch(`${BASE}/metrics`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const text = await res.text();
    let rss: number | null = null;
    let conns: number | null = null;
    try {
      const j = JSON.parse(text) as { rss_bytes?: number; live_connections?: number };
      rss = j.rss_bytes ?? null;
      conns = j.live_connections ?? null;
    } catch {
      const m = /^process_resident_memory_bytes\s+(\d+(?:\.\d+)?(?:e\+\d+)?)/m.exec(text);
      if (m) rss = Number(m[1]);
    }
    if (rss !== null) {
      metrics.rssStart ??= rss;
      metrics.rssPeak = Math.max(metrics.rssPeak ?? 0, rss);
      metrics.rssEnd = rss;
    }
    if (conns !== null) metrics.connectionsPeak = Math.max(metrics.connectionsPeak ?? 0, conns);
  } catch {
    /* metrics are optional */
  }
}

// ---------- statistics ----------

function percentiles(values: number[]) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
  return { count: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1]! };
}

// ---------- main ----------

async function main(): Promise<void> {
  const tokens = readTokens(opts.tokens!);
  log(`${tokens.length} tokens, target ${BASE}`);

  // Discover boards: by default each person's own board (created on first use), otherwise the boards a
  // token belongs to; with --board, only that board.
  for (const token of tokens) {
    let me: Whoami;
    try {
      me = await apiRetry<Whoami>(token, "/api/me");
      if (!opts.board && !me.owned_board && me.principal.kind === "human") {
        await api(token, "POST", "/api/boards", {});
        me = await apiRetry<Whoami>(token, "/api/me");
      }
    } catch (e) {
      log(`skipping a token: setup failed (${errCode(e)})`);
      continue;
    }
    const own = me.owned_board?.id;
    for (const m of me.memberships) {
      if (opts.board ? m.board_id !== opts.board : own !== undefined && m.board_id !== own) continue;
      let b = boards.get(m.board_id);
      if (!b) {
        if (boards.size >= MAX_BOARDS) continue;
        b = { id: m.board_id, uri: m.board_url, readers: [], writers: [], baseline: "", acked: [], ackedIds: new Set() };
        boards.set(b.id, b);
      }
      b.readers.push(token);
      if (m.role === "owner" || m.role === "contributor") b.writers.push(token);
    }
  }
  if (boards.size === 0) throw new Error(opts.board ? `No token is a member of board ${opts.board}` : "The tokens can't see any board");
  const boardList = [...boards.values()];
  const postBoards = boardList.filter((b) => b.writers.length > 0);
  if (POSTERS > 0 && postBoards.length === 0) throw new Error("No token can post to the chosen boards (needs contributor or owner)");
  log(`${boardList.length} boards; ${STREAMS} SSE + ${LISTENS} listen streams; ${POSTERS} posters at ${RATE}/s for ${DURATION_S}s${STORM ? `; restart storm at ${STORM_AT_S}s` : ""}`);

  // One thread per poster.
  const posterSetup: { board: Board; token: string; threadId: string }[] = [];
  for (let i = 0; i < POSTERS; i++) {
    const board = postBoards[i % postBoards.length]!;
    const token = board.writers[i % board.writers.length]!;
    const r = await api<{ thread: { id: string } }>(token, "POST", `/api/boards/${encodeURIComponent(board.id)}/threads`, {
      title: `Load test ${RUN_ID} · poster ${i}`,
      body: `Load test ${RUN_ID}: poster ${i} replies here.`,
      idempotency_key: `lt-${RUN_ID}-thread-${i}`,
    });
    posterSetup.push({ board, token, threadId: r.thread.id });
  }

  // Baseline cursors: completeness is checked against everything that happens after these.
  for (const b of boardList) b.baseline = (await apiRetry<ChangesPage>(b.readers[0]!, `/api/boards/${encodeURIComponent(b.id)}/changes`)).cursor;

  const make = (idx: number, kind: Stream["kind"]): Stream => {
    const board = boardList[idx % boardList.length]!;
    return {
      idx,
      kind,
      board,
      token: board.readers[Math.floor(idx / boardList.length) % board.readers.length]!,
      cursor: kind === "listen" ? board.baseline : null,
      initialCursor: kind === "listen" ? board.baseline : null,
      ready: false,
      everReady: false,
      connectedAt: 0,
      connects: 0,
      failures: {},
      resyncs: 0,
      ended: null,
      abort: null,
      seen: new Map(),
      lastSeq: 0,
      duplicates: 0,
      outOfOrder: 0,
      received: new Set(),
      live: [],
      catchUp: [],
      storm: null,
      fetching: false,
      dirty: false,
    };
  };
  for (let i = 0; i < STREAMS; i++) streams.push(make(i, "sse"));
  for (let i = 0; i < LISTENS; i++) streams.push(make(STREAMS + i, "listen"));

  await sampleMetrics();
  const openStarted = Date.now();
  await openAll(streams);
  const readyCount = streams.filter((s) => s.ready).length;
  log(`${readyCount}/${streams.length} streams ready in ${((Date.now() - openStarted) / 1000).toFixed(1)}s`);
  await sampleMetrics();

  // Progress and metrics sampling.
  const t0 = Date.now();
  const endAt = t0 + DURATION_S * 1000;
  const ticker = setInterval(() => {
    void sampleMetrics();
    const delivered = streams.reduce((n, s) => n + s.received.size, 0);
    const rss = metrics.rssEnd !== null ? ` rss=${Math.round(metrics.rssEnd / 1048576)}MiB` : "";
    log(`t=${Math.round((Date.now() - t0) / 1000)}s posts=${posts.accepted}/${posts.attempted} deliveries=${delivered} ready=${streams.filter((s) => s.ready).length}/${streams.length}${rss}`);
  }, 5000);

  // Restart storm.
  let stormTimer: NodeJS.Timeout | null = null;
  if (STORM) {
    stormTimer = setTimeout(() => {
      stormStartedAt = Date.now();
      log(`restart storm: dropping ${streams.length} streams; simulated downtime ${STORM_DOWNTIME_S}s`);
      for (const st of streams) {
        st.storm = { droppedAt: stormStartedAt, reconnectedAt: null, target: 0, ptr: 0, caughtUpAt: null };
        st.ready = false;
        st.abort?.abort();
      }
    }, STORM_AT_S * 1000);
  }

  await Promise.all(posterSetup.map((p, i) => poster(i, p.board, p.token, p.threadId, endAt)));
  if (stormTimer) clearTimeout(stormTimer);
  log(`posting done: ${posts.accepted} accepted of ${posts.attempted}; draining up to ${DRAIN_S}s`);

  // Drain: wait until every stream has every accepted message of its board.
  const drainUntil = Date.now() + DRAIN_S * 1000;
  const complete = (s: Stream) => s.ended !== null || [...s.board.ackedIds].every((id) => s.received.has(id));
  const stormSettled = () => !STORM || streams.every((s) => s.ended !== null || (s.storm !== null && s.storm.caughtUpAt !== null));
  while (Date.now() < drainUntil && !(streams.every(complete) && stormSettled())) await sleep(250);
  // Listen streams catch up once more so a trailing notification is not lost to timing.
  await Promise.all(streams.filter((s) => s.kind === "listen" && !s.ended).map((s) => catchUp(s)));
  clearInterval(ticker);
  await sampleMetrics();
  stopping = true;
  for (const st of streams) st.abort?.abort();

  // ---------- verification against the event log ----------
  const authoritative = new Map<string, number[]>();
  const eventsSince = async (b: Board, cursor: string): Promise<number[]> => {
    const key = `${b.id} ${cursor}`;
    const hit = authoritative.get(key);
    if (hit) return hit;
    const seqs: number[] = [];
    let c = cursor;
    for (;;) {
      const page = await apiRetry<ChangesPage>(b.readers[0]!, `/api/boards/${encodeURIComponent(b.id)}/changes?cursor=${encodeURIComponent(c)}&limit=100`);
      seqs.push(...page.changes.map((x) => x.seq));
      c = page.cursor;
      if (!page.has_more) break;
    }
    authoritative.set(key, seqs);
    return seqs;
  };

  let missingEvents = 0;
  let missingMessages = 0;
  let streamsComplete = 0;
  const worst: { stream: number; kind: string; board: string; missing_events: number; missing_messages: number }[] = [];
  for (const st of streams) {
    if (!st.initialCursor) continue;
    let expected: number[];
    try {
      expected = await eventsSince(st.board, st.initialCursor);
    } catch (e) {
      log(`verification read failed for board ${st.board.id} (${errCode(e)})`);
      continue;
    }
    const me = expected.filter((seq) => !st.seen.has(seq)).length;
    const mm = [...st.board.ackedIds].filter((id) => !st.received.has(id)).length;
    missingEvents += me;
    missingMessages += mm;
    if (me === 0 && mm === 0 && st.duplicates === 0 && st.outOfOrder === 0) streamsComplete++;
    else worst.push({ stream: st.idx, kind: st.kind, board: st.board.id, missing_events: me, missing_messages: mm });
  }
  worst.sort((a, b) => b.missing_events + b.missing_messages - (a.missing_events + a.missing_messages));

  const failures: Record<string, number> = {};
  for (const st of streams) for (const [k, v] of Object.entries(st.failures)) failures[k] = (failures[k] ?? 0) + v;
  const live = percentiles(streams.flatMap((s) => s.live));
  const checked = streams.filter((s) => s.initialCursor).length;
  const duplicates = streams.reduce((n, s) => n + s.duplicates, 0);
  const outOfOrder = streams.reduce((n, s) => n + s.outOfOrder, 0);

  let storm: Record<string, unknown> | null = null;
  if (STORM && stormStartedAt !== null) {
    const serverBack = stormStartedAt + STORM_DOWNTIME_S * 1000;
    const caught = streams.filter((s) => s.storm?.caughtUpAt != null);
    const recoveryS = caught.length ? (Math.max(...caught.map((s) => s.storm!.caughtUpAt!)) - serverBack) / 1000 : null;
    const replay = percentiles(caught.map((s) => s.storm!.caughtUpAt! - s.storm!.reconnectedAt!));
    const reconnect = percentiles(streams.filter((s) => s.storm?.reconnectedAt != null).map((s) => s.storm!.reconnectedAt! - serverBack));
    storm = {
      downtime_s: STORM_DOWNTIME_S,
      streams_dropped: streams.length,
      streams_caught_up: caught.length,
      all_caught_up: caught.length === streams.filter((s) => !s.ended).length,
      seconds_to_all_caught_up_after_server_back: recoveryS,
      reconnect_after_server_back_ms: reconnect,
      replay_after_reconnect_ms: replay,
    };
  }

  const rssGrowth = metrics.rssPeak !== null && metrics.rssStart !== null ? metrics.rssPeak - metrics.rssStart : null;
  const targets = {
    p95_delivery_under_1s: live.p95 !== null ? live.p95 < 1000 : null,
    no_missing_or_duplicate: checked > 0 ? missingEvents === 0 && missingMessages === 0 && duplicates === 0 : null,
    restart_storm_caught_up_within_60s: storm ? storm.all_caught_up === true && typeof storm.seconds_to_all_caught_up_after_server_back === "number" && storm.seconds_to_all_caught_up_after_server_back <= 60 : null,
    all_streams_opened: readyCount === streams.length,
  };
  const summary = {
    run_id: RUN_ID,
    url: BASE,
    config: { streams: STREAMS, listens: LISTENS, posters: POSTERS, rate_per_s: RATE, duration_s: DURATION_S, boards: boardList.length, restart_storm: STORM },
    posts: { ...posts, achieved_rate_per_s: Number((posts.accepted / Math.max(1, DURATION_S)).toFixed(2)) },
    streams: {
      opened: readyCount,
      requested: streams.length,
      connects: streams.reduce((n, s) => n + s.connects, 0),
      resyncs: streams.reduce((n, s) => n + s.resyncs, 0),
      access_ended: streams.filter((s) => s.ended).length,
      failures,
    },
    latency_ms: live,
    latency_ms_by_kind: {
      sse: percentiles(streams.filter((s) => s.kind === "sse").flatMap((s) => s.live)),
      listen: percentiles(streams.filter((s) => s.kind === "listen").flatMap((s) => s.live)),
    },
    catch_up_latency_ms: percentiles(streams.flatMap((s) => s.catchUp)),
    completeness: {
      streams_checked: checked,
      streams_complete: streamsComplete,
      missing_events: missingEvents,
      missing_messages: missingMessages,
      duplicate_events: duplicates,
      out_of_order_events: outOfOrder,
      worst: worst.slice(0, 10),
    },
    storm,
    server: {
      rss_bytes_start: metrics.rssStart,
      rss_bytes_peak: metrics.rssPeak,
      rss_bytes_end: metrics.rssEnd,
      rss_bytes_per_stream: rssGrowth !== null && streams.length ? Math.round(rssGrowth / streams.length) : null,
      live_connections_peak: metrics.connectionsPeak,
    },
    targets,
    passed: Object.values(targets).every((v) => v !== false),
  };
  const json = JSON.stringify(summary, null, 2);
  process.stdout.write(json + "\n");
  if (opts.out) writeFileSync(opts.out, json + "\n");
  process.exit(summary.passed ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e));
  process.exit(2);
});

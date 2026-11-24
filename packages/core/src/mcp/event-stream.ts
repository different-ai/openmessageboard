import type { EventName } from "@openmessageboard/protocol";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { OmbError } from "../errors.js";
import { activeMembership, getPrincipal } from "../domain/access.js";
import type { Actor } from "../domain/model.js";
import type { CloseReason } from "../live/connections.js";
import { encodeCursor } from "../domain/cursors.js";
import { METHOD_SCOPE, requireScope } from "../auth/scopes.js";
import { EVENT_ERRORS, EventsError, authorize, currentSeq, cursorScope, decodeEventCursor, occurrencesAfter, parseArgs, type Occurrence } from "./events.js";

const SUB_META = "io.modelcontextprotocol/subscriptionId";
const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_HEARTBEAT_MS = 60_000;

interface StreamRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "events/stream";
  params?: unknown;
}

export function isEventStreamRequest(body: unknown): body is StreamRequest {
  return !!body && typeof body === "object" && (body as { method?: unknown }).method === "events/stream" && "id" in (body as object);
}

const StreamParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  heartbeatMs: z.number().int().positive().optional(),
});

function rpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }), { status, headers: { "content-type": "application/json" } });
}

/** Decodes an `Mcp-Name` header, including the `=?base64?…?=` sentinel for values that are not plain ASCII. */
function decodeNameHeader(raw: string): string | undefined {
  const m = /^=\?base64\?(.*)\?=$/i.exec(raw.trim());
  if (!m) return raw.trim();
  try {
    return Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

const TERMINATION_REASON: Record<CloseReason, string | null> = {
  removed: "access_ended",
  expired: "access_ended",
  disabled: "principal_disabled",
  board_deleted: "board_deleted",
  role_changed: null,
  shutdown: null,
};

/**
 * MCP Events push delivery (`events/stream`, SEP-3415). One SSE response per subscription: a
 * `notifications/events/active` confirmation, then `notifications/events/event` per occurrence, `heartbeat` data
 * frames carrying the checked-up-to cursor, and `terminated` when the subscriber loses access. Occurrences are read
 * from the same durable log as poll and webhook delivery, so a client that reconnects with its last cursor misses
 * nothing within the retention window.
 */
export function serveEventStream(ctx: AppContext, actor: Actor, req: StreamRequest, headers: Headers, signal: AbortSignal): Response {
  const p = StreamParams.safeParse(req.params ?? {});
  if (!p.success) return rpcError(req.id, -32602, `Invalid params: ${p.error.issues[0]?.path.join(".") ?? ""} ${p.error.issues[0]?.message ?? ""}`.trim());
  // SEP-3415 routing header: when present it must name the same event as the body.
  const header = headers.get("mcp-name");
  if (header !== null) {
    const decoded = decodeNameHeader(header);
    if (decoded !== p.data.name) return rpcError(req.id, EVENT_ERRORS.HeaderMismatch, "HeaderMismatch", { header: "Mcp-Name", expected: p.data.name }, 400);
  }
  let name: EventName;
  let args: ReturnType<typeof parseArgs>;
  let seq: number;
  let truncated: boolean;
  const scope = () => cursorScope(name, actor, args);
  try {
    requireScope(actor, METHOD_SCOPE["events/stream"] ?? "read");
    args = parseArgs(p.data.name, p.data.arguments);
    name = p.data.name as EventName;
    authorize(ctx, actor, name, args);
    ({ seq, truncated } = decodeEventCursor(ctx, p.data.cursor, scope()));
  } catch (e) {
    if (e instanceof EventsError) return rpcError(req.id, e.code, e.message, e.data);
    if (e instanceof OmbError) return rpcError(req.id, EVENT_ERRORS.Forbidden, e.message, { code: e.code });
    throw e;
  }
  try {
    ctx.rate.hit(`s:p:${actor.id}`, ctx.config.rateLimits.streams_per_minute_principal, 60_000);
  } catch (e) {
    return rpcError(req.id, EVENT_ERRORS.ResourceExhausted, e instanceof OmbError ? e.message : "Too many streams", { limit: "streams_per_minute_principal" });
  }
  const minHeartbeat = ctx.config.testMode ? 200 : 5_000;
  const heartbeatMs = Math.min(Math.max(p.data.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, minHeartbeat), MAX_HEARTBEAT_MS);
  const minTime = p.data.maxAgeMs ? new Date(ctx.now().getTime() - p.data.maxAgeMs).toISOString() : undefined;
  const boardId = args.board_id;

  const encoder = new TextEncoder();
  const subId = req.id;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let lastWrite = Date.now();
  let draining = false;
  let dirty = false;
  let firstDrain = true;
  let heartbeat: NodeJS.Timeout | null = null;
  let unsub: (() => void) | null = null;
  let conn: ReturnType<typeof ctx.connections.register> | null = null;

  const write = (message: Record<string, unknown>) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      lastWrite = Date.now();
    } catch {
      teardown(false);
    }
  };
  const notify = (method: string, params: Record<string, unknown>) => write({ jsonrpc: "2.0", method, params: { ...params, _meta: { [SUB_META]: subId } } });
  const cursorNow = () => encodeCursor(scope().kind, scope().id, seq);
  const teardown = (graceful: boolean) => {
    if (closed) return;
    if (graceful) write({ jsonrpc: "2.0", id: subId, result: { resultType: "complete", _meta: { [SUB_META]: subId } } });
    closed = true;
    unsub?.();
    if (heartbeat) clearInterval(heartbeat);
    if (conn) ctx.connections.unregister(conn);
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  };
  const terminate = (reason: string, code?: string) => {
    notify("notifications/events/terminated", { error: { code: EVENT_ERRORS.Forbidden, message: "Forbidden", data: { reason, ...(code ? { code } : {}) } } });
    teardown(true);
  };

  /** Reads everything after `seq` and sends it; re-checks access first so a lost membership ends the stream. */
  const drain = () => {
    if (closed) return;
    if (draining) {
      dirty = true;
      return;
    }
    draining = true;
    try {
      do {
        dirty = false;
        try {
          authorize(ctx, actor, name, args);
        } catch (e) {
          if (e instanceof EventsError) {
            const code = String(e.data?.code ?? "not_found");
            terminate(code === "access_ended" ? "access_ended" : "not_found", code);
            return;
          }
          throw e;
        }
        for (;;) {
          const r = occurrencesAfter(ctx, actor, name, args, seq, 50, firstDrain ? minTime : undefined);
          for (const ev of r.events) notify("notifications/events/event", ev as unknown as Record<string, unknown>);
          seq = r.lastSeq;
          if (!r.hasMore) {
            // Board subscriptions have checked the whole log up to now; the heartbeat cursor moves past quiet rows.
            if (scope().kind === "b") seq = Math.max(seq, currentSeq(ctx, scope()));
            break;
          }
        }
        firstDrain = false;
      } while (dirty && !closed);
    } catch (e) {
      console.error("events/stream delivery failed", e);
      notify("notifications/events/error", { error: { code: -32603, message: "Internal error", data: { reason: "internal" } } });
    } finally {
      draining = false;
    }
  };
  const schedule = () => setImmediate(drain);

  if (boardId) {
    try {
      conn = ctx.connections.register({
        principalId: actor.id,
        kind: "events_push",
        boards: new Set([boardId]),
        close: (reason: CloseReason) => {
          const why = TERMINATION_REASON[reason];
          if (why === null) {
            if (reason === "shutdown") teardown(true);
            else schedule();
            return;
          }
          // closeFor runs before the membership row changes in some paths; only terminate on a real loss.
          if (reason !== "disabled" && reason !== "board_deleted" && activeMembership(ctx, boardId, actor)) return;
          terminate(why);
        },
      });
    } catch (e) {
      const details = e instanceof OmbError ? (e.details as Record<string, unknown> | undefined) : undefined;
      return rpcError(req.id, EVENT_ERRORS.ResourceExhausted, e instanceof OmbError ? e.message : "Live connection limit reached", {
        limit: "live_connections",
        ...(details?.limit !== undefined ? { max: details.limit } : {}),
      });
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      notify("notifications/events/active", { cursor: cursorNow(), truncated, heartbeatMs });
      unsub = ctx.hub.subscribe((e) => {
        if (closed) return;
        if (e.kind === "board" || e.kind === "grants") {
          if (boardId && e.boardId === boardId) schedule();
        } else if (e.kind === "inbox") {
          if (name === "inbox.item_created" && e.principalId === actor.id && (!boardId || e.boardId === boardId)) schedule();
        } else if (e.kind === "access" && e.principalId === actor.id) {
          if (e.reason === "disabled") return terminate("principal_disabled");
          if (boardId && e.boardId === boardId && e.reason !== "role_changed" && !activeMembership(ctx, boardId, actor)) return terminate("access_ended");
          if (boardId && e.boardId === boardId) schedule();
        } else if (e.kind === "board_deleted" && boardId && e.boardId === boardId) terminate("board_deleted");
      });
      // Catch up from the requested cursor before anything new arrives.
      schedule();
      heartbeat = setInterval(() => {
        if (closed) return;
        const principal = getPrincipal(ctx, actor.id);
        if (!principal || principal.disabled_at) return terminate("principal_disabled");
        if (Date.now() - lastWrite >= heartbeatMs - 50) notify("notifications/events/heartbeat", { cursor: cursorNow() });
      }, Math.max(100, Math.floor(heartbeatMs / 2)));
      heartbeat.unref();
    },
    cancel() {
      teardown(false);
    },
  });
  if (signal.aborted) teardown(false);
  else signal.addEventListener("abort", () => teardown(false), { once: true });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

export type { Occurrence };

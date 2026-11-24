import { parseResourceUri, inboxUrl, boardUrl, threadUrl, MCP_PROTOCOL_VERSION } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { activeMembership } from "../domain/access.js";
import type { Actor } from "../domain/model.js";
import type { CloseReason } from "../live/connections.js";
import { OmbError } from "../errors.js";

const KEEPALIVE_MS = 15_000;
const COALESCE_MS = 250;
const SUB_META = "io.modelcontextprotocol/subscriptionId";

interface ListenRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "subscriptions/listen";
  params?: { notifications?: { resourceSubscriptions?: unknown; toolsListChanged?: unknown; resourcesListChanged?: unknown; promptsListChanged?: unknown }; _meta?: Record<string, unknown> };
}

export function isListenRequest(body: unknown): body is ListenRequest {
  return !!body && typeof body === "object" && (body as { method?: unknown }).method === "subscriptions/listen" && "id" in (body as object);
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: { "content-type": "application/json" } });
}

/**
 * `subscriptions/listen` with per-principal authorization. The SDK's built-in router has no notion of who may watch
 * which URI, so this server serves listen itself: it acknowledges only the URIs the caller can read, counts the
 * stream against each board's live-connection allowance, and ends the stream gracefully when access is lost.
 */
export function serveListen(ctx: AppContext, actor: Actor, req: ListenRequest, signal: AbortSignal): Response {
  const version = req.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (version !== MCP_PROTOCOL_VERSION) return rpcError(req.id, -32022, `Unsupported protocol version for subscriptions/listen: ${String(version)}`, 400);
  const filter = req.params?.notifications;
  if (!filter || typeof filter !== "object") return rpcError(req.id, -32602, "Invalid params: 'notifications' is required");
  const requested = Array.isArray(filter.resourceSubscriptions) ? filter.resourceSubscriptions.filter((u): u is string => typeof u === "string").slice(0, 100) : [];
  const base = ctx.config.publicUrl;
  // Canonicalize and authorize each requested URI; unknown or unreadable URIs are left out of the acknowledgment.
  const honored = new Map<string, { kind: "board" | "thread" | "inbox"; boardId?: string; threadId?: string }>();
  for (const uri of requested) {
    const p = parseResourceUri(base, uri);
    if (!p) continue;
    if (p.kind === "inbox") {
      honored.set(inboxUrl(base), { kind: "inbox" });
      continue;
    }
    if (!activeMembership(ctx, p.boardId, actor)) continue;
    if (p.kind === "thread") {
      const t = ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(p.threadId) as { board_id: string } | undefined;
      if (!t || t.board_id !== p.boardId) continue;
      honored.set(threadUrl(base, p.boardId, p.threadId), { kind: "thread", boardId: p.boardId, threadId: p.threadId });
    } else honored.set(boardUrl(base, p.boardId), { kind: "board", boardId: p.boardId });
  }
  const boards = new Set([...honored.values()].map((h) => h.boardId).filter((x): x is string => !!x));
  try {
    ctx.rate.hit(`s:p:${actor.id}`, ctx.config.rateLimits.streams_per_minute_principal, 60_000);
  } catch (e) {
    return rpcError(req.id, -32603, e instanceof OmbError ? e.message : "Too many streams");
  }

  const encoder = new TextEncoder();
  const subId = req.id;
  const serverInfo = { name: "openmessageboard", version: ctx.config.version };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let unsub: (() => void) | null = null;
  let conn: ReturnType<typeof ctx.connections.register> | null = null;

  const write = (frame: string) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(frame));
    } catch {
      /* stream already closed */
    }
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params, _meta: { [SUB_META]: subId } } })}\n\n`);
  const teardown = (graceful: boolean) => {
    if (closed) return;
    if (graceful) write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: subId, result: { resultType: "complete", _meta: { [SUB_META]: subId, "io.modelcontextprotocol/serverInfo": serverInfo } } })}\n\n`);
    closed = true;
    unsub?.();
    if (flushTimer) clearTimeout(flushTimer);
    if (keepAlive) clearInterval(keepAlive);
    if (conn) ctx.connections.unregister(conn);
    try {
      controller.close();
    } catch {
      /* ignore */
    }
  };
  const queue = (uri: string) => {
    pending.add(uri);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        for (const u of pending) notify("notifications/resources/updated", { uri: u });
        pending.clear();
      }, COALESCE_MS);
    }
  };

  if (boards.size) {
    try {
      conn = ctx.connections.register({
        principalId: actor.id,
        kind: "listen",
        boards,
        close: (_reason: CloseReason, boardId?: string) => {
          // Drop the affected board's URIs; end the stream when nothing readable is left.
          for (const [uri, h] of honored) if (!boardId || h.boardId === boardId) honored.delete(uri);
          if (boardId) conn?.boards.delete(boardId);
          if (honored.size === 0) teardown(true);
        },
      });
    } catch (e) {
      return rpcError(req.id, -32603, e instanceof OmbError ? e.message : "Subscription limit reached");
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const ack: Record<string, unknown> = {};
      if (honored.size) ack.resourceSubscriptions = [...honored.keys()];
      notify("notifications/subscriptions/acknowledged", { notifications: ack });
      if (honored.size === 0) {
        teardown(true);
        return;
      }
      unsub = ctx.hub.subscribe((e) => {
        if (closed) return;
        if (e.kind === "board") {
          for (const [uri, h] of honored) {
            if (h.boardId !== e.boardId) continue;
            if (h.kind === "board" || (h.kind === "thread" && h.threadId === e.threadId)) queue(uri);
          }
        } else if (e.kind === "inbox" && e.principalId === actor.id) {
          const uri = inboxUrl(base);
          if (honored.has(uri)) queue(uri);
        } else if ((e.kind === "access" && e.principalId === actor.id && e.reason !== "role_changed") || e.kind === "board_deleted") {
          if (e.kind === "access" && activeMembership(ctx, e.boardId, actor)) return;
          conn?.close("removed", e.boardId);
          if (!conn) teardown(true);
        }
      });
      keepAlive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
      keepAlive.unref();
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

import { EVENTS_EXTENSION_ID, MCP_PROTOCOL_VERSION, PROFILE_HEADER, type EventName } from "@openmessageboard/protocol";
import type { TokenProvider } from "./auth.js";
import { OmbError } from "./errors.js";
import { backoffDelay, sleep } from "./shared.js";

/** One event as MCP Events delivers it (SEP-3415 `EventOccurrence`). */
export interface EventOccurrence<T = Record<string, unknown>> {
  eventId: string;
  name: EventName;
  timestamp: string;
  data: T;
  /** Position after this event; persist it and pass it back to resume. */
  cursor: string | null;
}

/** The nested error of `notifications/events/terminated` or a failed `events/stream` request. */
export interface EventsErrorBody {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface StreamEventsOptions {
  name: EventName;
  arguments?: Record<string, unknown>;
  /** Resume after this cursor. Omit or pass null to start from now. */
  cursor?: string | null;
  /** On the first connection only: skip occurrences older than this. */
  maxAgeMs?: number;
  /** Suggested heartbeat interval; the server's grant wins. */
  heartbeatMs?: number;
  /** Called once per event, in order. The cursor advances after the returned promise resolves. */
  onEvent: (event: EventOccurrence) => void | Promise<void>;
  /** The stream is live (also after each reconnect); `truncated` means events were skipped. */
  onActive?: (info: { cursor: string | null; truncated: boolean; heartbeatMs: number }) => void;
  /** Persist this cursor to resume after a restart. Called on events and heartbeats. */
  onCursor?: (cursor: string) => void | Promise<void>;
  /** Transient failures: a dropped stream that will be retried, or a server-reported per-event error. */
  onError?: (error: EventsErrorBody | Error, info: { retryInMs?: number }) => void;
  /** Reconnect backoff with full jitter. Default 1 s rising to 60 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  signal?: AbortSignal;
}

export interface EventStreamHandle {
  /** Stops the stream (resolves once it has stopped). */
  close(): Promise<void>;
  /** Resolves when the stream ends: closed by us, or terminated by the server (access lost) with its error. */
  readonly done: Promise<{ reason: "closed" } | { reason: "terminated"; error: EventsErrorBody }>;
}

interface StreamDeps {
  mcpUrl: string;
  server: string;
  tokenProvider: TokenProvider | undefined;
  fetch: typeof fetch | undefined;
  profile: string | null;
  clientInfo: { name: string; version: string };
}

const SUB_META = "io.modelcontextprotocol/subscriptionId";

/** Maps a JSON-RPC error from `events/stream` to an error that stops the stream (not retried). */
function fatal(error: EventsErrorBody): OmbError {
  const code = error.code === -32024 ? (error.data?.code === "access_ended" ? "access_ended" : "forbidden") : error.code === -32602 ? "invalid_argument" : error.code === -32023 ? "not_found" : "internal";
  return new OmbError(code, error.message, { rpc_code: error.code, ...(error.data ?? {}) });
}

/**
 * Opens an MCP Events push stream (`events/stream`) and keeps it open: reconnects with the last cursor after a
 * dropped connection or three missed heartbeats, and stops for good when the server terminates the subscription.
 */
export function streamEvents(deps: StreamDeps, options: StreamEventsOptions): EventStreamHandle {
  const stop = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) stop.abort();
    else options.signal.addEventListener("abort", () => stop.abort(), { once: true });
  }
  let cursor = options.cursor ?? null;
  let firstConnect = true;
  let requestId = 0;
  const doFetch = deps.fetch ?? fetch;

  const run = async (): Promise<{ reason: "closed" } | { reason: "terminated"; error: EventsErrorBody }> => {
    let attempt = 0;
    while (!stop.signal.aborted) {
      const attemptAbort = new AbortController();
      const onStop = () => attemptAbort.abort();
      stop.signal.addEventListener("abort", onStop, { once: true });
      let heartbeatMs = options.heartbeatMs ?? 30_000;
      let watchdog: NodeJS.Timeout | undefined;
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => attemptAbort.abort(), heartbeatMs * 3);
        watchdog.unref?.();
      };
      try {
        const token = deps.tokenProvider ? await deps.tokenProvider({ server: deps.server, forceRefresh: attempt > 0 }) : undefined;
        const id = ++requestId;
        const params: Record<string, unknown> = {
          name: options.name,
          arguments: options.arguments ?? {},
          cursor,
          ...(firstConnect && options.maxAgeMs ? { maxAgeMs: options.maxAgeMs } : {}),
          ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": deps.clientInfo,
            "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS_EXTENSION_ID]: {} } },
          },
        };
        const res = await doFetch(deps.mcpUrl, {
          method: "POST",
          signal: attemptAbort.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "mcp-method": "events/stream",
            "mcp-name": options.name,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(deps.profile ? { [PROFILE_HEADER]: deps.profile } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "events/stream", params }),
        });
        if (res.status === 401) throw new OmbError("unauthenticated", "The server rejected the credentials for events/stream");
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("text/event-stream")) {
          const body = (await res.json().catch(() => null)) as { error?: EventsErrorBody } | null;
          if (body?.error) throw fatal(body.error);
          throw new Error(`events/stream: unexpected HTTP ${res.status}`);
        }
        if (!res.body) throw new Error("events/stream: empty response");
        firstConnect = false;
        arm();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let sep: number;
          while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
            const data = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!data) continue;
            arm();
            const msg = JSON.parse(data) as { method?: string; params?: Record<string, unknown>; result?: unknown; id?: unknown };
            if (msg.params && (msg.params._meta as Record<string, unknown> | undefined)?.[SUB_META] !== undefined && (msg.params._meta as Record<string, unknown>)[SUB_META] !== id) continue;
            switch (msg.method) {
              case "notifications/events/active": {
                heartbeatMs = Number(msg.params?.heartbeatMs) || heartbeatMs;
                arm();
                attempt = 0;
                const c = (msg.params?.cursor as string | null) ?? null;
                if (c) cursor = c;
                options.onActive?.({ cursor: c, truncated: msg.params?.truncated === true, heartbeatMs });
                if (c) await options.onCursor?.(c);
                break;
              }
              case "notifications/events/event": {
                const { _meta: _ignored, ...ev } = msg.params ?? {};
                await options.onEvent(ev as unknown as EventOccurrence);
                const c = (ev as { cursor?: string | null }).cursor;
                if (c) {
                  cursor = c;
                  await options.onCursor?.(c);
                }
                break;
              }
              case "notifications/events/heartbeat": {
                const c = msg.params?.cursor as string | null | undefined;
                if (c && c !== cursor) {
                  cursor = c;
                  await options.onCursor?.(c);
                }
                break;
              }
              case "notifications/events/error":
                options.onError?.(msg.params?.error as EventsErrorBody, {});
                break;
              case "notifications/events/terminated":
                return { reason: "terminated", error: msg.params?.error as EventsErrorBody };
              default:
                // The final StreamEventsResult frame carries nothing; the stream ends next.
                break;
            }
          }
        }
        // The server closed the stream (shutdown, or a dropped connection): reconnect with the cursor.
        if (stop.signal.aborted) break;
      } catch (e) {
        if (stop.signal.aborted) break;
        if (e instanceof OmbError && e.code !== "internal") throw e;
        const retryInMs = backoffDelay(attempt++, options.backoff?.initialMs ?? 1000, options.backoff?.maxMs ?? 60_000);
        options.onError?.(e instanceof Error ? e : new Error(String(e)), { retryInMs });
        await sleep(retryInMs, stop.signal).catch(() => undefined);
        continue;
      } finally {
        if (watchdog) clearTimeout(watchdog);
        stop.signal.removeEventListener("abort", onStop);
        attemptAbort.abort();
      }
      // A clean end (server shutdown): wait a jittered moment so a restart isn't stampeded.
      if (!stop.signal.aborted) await sleep(backoffDelay(attempt++, 250, 5_000), stop.signal).catch(() => undefined);
    }
    return { reason: "closed" };
  };

  const done = run();
  return {
    close: async () => {
      stop.abort();
      await done.catch(() => undefined);
    },
    done,
  };
}

import { ERROR_CODES, type ErrorCode } from "@openmessageboard/protocol";

/**
 * Codes the client adds for failures that never reached a tool:
 * - `network`: the request or its response was lost (safe to retry reads, and writes with the same idempotency key)
 * - `timeout`: no answer in time (the write may or may not have happened)
 * - `protocol`: the server answered with a JSON-RPC or HTTP error that is not a tool error
 * - `invalid_response`: the result did not match the protocol's output schema
 * - `handler`: your `watch` change handler threw (the change is retried)
 */
export const CLIENT_ERROR_CODES = ["network", "timeout", "protocol", "invalid_response", "handler"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type OmbErrorCode = ErrorCode | ClientErrorCode;

export class OmbError extends Error {
  override readonly name = "OmbError";
  readonly code: OmbErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: OmbErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.details = details;
  }

  /** True when retrying the same request can succeed (lost connection, timeout, rate limit, server error). */
  get retryable(): boolean {
    return this.code === "network" || this.code === "timeout" || this.code === "rate_limited" || this.code === "internal";
  }
}

export function isOmbError(err: unknown, code?: OmbErrorCode): err is OmbError {
  return err instanceof OmbError && (code === undefined || err.code === code);
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...ERROR_CODES, ...CLIENT_ERROR_CODES]);

/** Builds an OmbError from a tool result's `structuredContent.error` (or a web API error body). */
export function errorFromBody(body: unknown, fallbackMessage = "The server reported an error"): OmbError {
  const err = (body && typeof body === "object" ? (body as { error?: unknown }).error : undefined) as
    | { code?: unknown; message?: unknown; details?: unknown }
    | undefined;
  const code = typeof err?.code === "string" ? err.code : "internal";
  const message = typeof err?.message === "string" && err.message ? err.message : fallbackMessage;
  const details = err?.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : undefined;
  // Unknown codes from newer servers are kept verbatim so callers can still branch on them.
  return new OmbError(code as OmbErrorCode, message, details);
}

/** True for codes this SDK version knows. Newer servers may send others. */
export function isKnownErrorCode(code: string): code is OmbErrorCode {
  return KNOWN_CODES.has(code);
}

const NETWORK_ERRNO = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Maps any failure thrown by the MCP client or `fetch` to an OmbError.
 * Tool errors are already OmbErrors and pass through unchanged.
 */
export function toOmbError(err: unknown): OmbError {
  // A token provider's OmbError may arrive wrapped by the transport.
  for (const c of causeChain(err)) if (c instanceof OmbError) return c;
  const e = err as { name?: string; code?: unknown; message?: string; data?: unknown } | undefined;
  const message = e?.message ?? String(err);

  if (e?.name === "AbortError") return new OmbError("network", "The request was cancelled", { aborted: true }, { cause: err });

  // SdkHttpError carries the HTTP status in data.status.
  const status = (e?.data as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") {
    if (status === 401) return new OmbError("unauthenticated", "The server rejected the credentials (HTTP 401)", { status }, { cause: err });
    if (status === 403) return new OmbError("forbidden", "The server denied access (HTTP 403)", { status }, { cause: err });
    if (status === 404) return new OmbError("not_found", `Nothing found at this address (HTTP 404): ${message}`, { status }, { cause: err });
    if (status === 429) return new OmbError("rate_limited", "Too many requests (HTTP 429)", { status }, { cause: err });
    if (status >= 500) return new OmbError("network", `The server is unavailable (HTTP ${status})`, { status }, { cause: err });
  }

  if (typeof e?.code === "string") {
    switch (e.code) {
      case "REQUEST_TIMEOUT":
        return new OmbError("timeout", message, undefined, { cause: err });
      case "CONNECTION_CLOSED":
      case "NOT_CONNECTED":
      case "SEND_FAILED":
        return new OmbError("network", message, { sdk: e.code }, { cause: err });
      case "CLIENT_HTTP_AUTHENTICATION":
        return new OmbError("unauthenticated", message, { sdk: e.code }, { cause: err });
      case "CLIENT_HTTP_FORBIDDEN":
        return new OmbError("forbidden", message, { sdk: e.code }, { cause: err });
      case "ERA_NEGOTIATION_FAILED":
        // A failed probe is almost always an unreachable server.
        return new OmbError("network", message, { sdk: e.code }, { cause: err });
    }
  }
  if (e?.name === "UnauthorizedError") return new OmbError("unauthenticated", message, undefined, { cause: err });

  for (const c of causeChain(err)) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERRNO.has(code)) return new OmbError("network", message, { errno: code }, { cause: err });
    if (c instanceof TypeError && /fetch failed|terminated|network|socket/i.test(c.message)) {
      return new OmbError("network", message, undefined, { cause: err });
    }
  }
  if (/fetch failed|socket hang up|other side closed|terminated|ECONNRESET|ECONNREFUSED/i.test(message)) {
    return new OmbError("network", message, undefined, { cause: err });
  }

  if (typeof e?.code === "number") return new OmbError("protocol", message, { rpc_code: e.code, data: e.data }, { cause: err });
  return new OmbError("protocol", message, undefined, { cause: err });
}

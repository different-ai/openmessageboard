import { createHmac, timingSafeEqual } from "node:crypto";
import { OmbError } from "../errors.js";

/** A failed platform call. `retryable` errors are retried by the outbound worker; others fail at once. */
export class SyncHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

/** fetch with a timeout. Network failures and timeouts become retryable `SyncHttpError`s. Never logs bodies. */
export async function fetchJson(platform: string, url: string, init: RequestInit, timeoutMs: number): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw new SyncHttpError(name === "TimeoutError" || name === "AbortError" ? `${platform} did not answer in time` : `Couldn't reach ${platform}`, null, true);
  }
  let json: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, json };
}

/** Parses a Retry-After header given in seconds. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const s = Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.min(s, 3600) * 1000 : undefined;
}

/** Turns a platform failure during an owner's request (linking a thread) into an API error. */
export function platformError(platform: string, e: unknown): OmbError {
  if (e instanceof OmbError) return e;
  if (e instanceof SyncHttpError) {
    if (e.status === 429) return new OmbError("rate_limited", `${platform} is rate limiting requests; try again shortly`, e.retryAfterMs ? { retry_after_ms: e.retryAfterMs } : undefined);
    if (e.retryable) return new OmbError("internal", e.message);
    return new OmbError("invalid_argument", e.message);
  }
  return new OmbError("internal", `Unexpected error talking to ${platform}`);
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 300 ? msg.slice(0, 297) + "..." : msg;
}

// ---------- signatures ----------

export function hmacHex(secret: string, ...parts: (string | Buffer)[]): string {
  const h = createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const badSignature = () => new OmbError("unauthenticated", "Webhook signature is missing or invalid");

// ---------- small value helpers ----------

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});
export function idString(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

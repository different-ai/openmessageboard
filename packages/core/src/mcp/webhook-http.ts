import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context.js";
import type { CallbackPolicy } from "../platform.js";

export type { CallbackPolicy };

/** 4 or 6 for an IP literal, otherwise 0 (portable stand-in for node:net's isIP). */
export function isIP(s: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 4;
  if (s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s)) return 6;
  return 0;
}

/** True for addresses a server must never call on a user's behalf (RFC 6890 special-use ranges). */
export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) return isPrivateAddress(ip.slice(7));
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

export const isLoopbackAddress = (ip: string) => ip === "::1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1";

// ---------- the delivery contract Events webhooks and watchers share (spec 14) ----------

/** How long a receiver has to answer a delivery or a verification. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The largest body a delivery carries; a larger one is dropped and recorded. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** A delivery is attempted at most this many times, */
export const WEBHOOK_MAX_ATTEMPTS = 10;
/** and never after this long. */
export const WEBHOOK_RETRY_WINDOW_MS = 24 * 3_600_000;
/** An endpoint is verified again when its last successful delivery or verification is older than this. */
export const WEBHOOK_REVERIFY_MS = 24 * 3_600_000;

export const webhookBodyTooLarge = (body: string): boolean => Buffer.byteLength(body, "utf8") > WEBHOOK_MAX_BODY_BYTES;

/** Exponential backoff with jitter after `attempts` failed attempts, capped at an hour. */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 3_600_000) * (0.5 + Math.random() / 2);
}

/** Whether a delivery that just failed its `attempts`-th attempt has used up its attempts or its 24 hours. */
export function webhookRetriesSpent(attempts: number, createdAt: string, now: Date): boolean {
  return attempts >= WEBHOOK_MAX_ATTEMPTS || now.getTime() - Date.parse(createdAt) >= WEBHOOK_RETRY_WINDOW_MS;
}


export class CallbackError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
  }
}

export function validateCallbackUrl(raw: string, policy: CallbackPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackError("invalid_url", "delivery.url must be an absolute URL");
  }
  if (url.username || url.password) throw new CallbackError("invalid_url", "delivery.url must not contain credentials");
  const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && policy.allowLoopbackHttp && loopbackHost) return url;
  throw new CallbackError("invalid_url", "delivery.url must use https");
}

export interface SignedPost {
  status: number;
  body: string;
}

/** Standard Webhooks signature: base64(HMAC-SHA256(secret bytes, `${id}.${timestamp}.${body}`)). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function newWebhookId(): string {
  return "msg_" + randomBytes(16).toString("base64url");
}

/**
 * Signs and POSTs `body` to a callback URL through the runtime's transport, which enforces the address rules and the
 * timeout. Literal private addresses are refused here as well, before any network work.
 */
export function postSigned(
  ctx: AppContext,
  url: URL,
  body: string,
  headers: { webhookId: string; secret: string; subscriptionId?: string; watcherId?: string },
  policy: CallbackPolicy,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<SignedPost> {
  const ts = Math.floor(Date.now() / 1000);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host) && !(policy.allowLoopbackHttp && isLoopbackAddress(host))) {
    return Promise.reject(new CallbackError("private_address", "Refusing to call a private address"));
  }
  return ctx.platform.callbacks.request(
    url,
    {
      method: "POST",
      timeoutMs,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "OpenMessageBoard-Webhooks/0.1",
        "webhook-id": headers.webhookId,
        "webhook-timestamp": String(ts),
        "webhook-signature": signWebhook(headers.secret, headers.webhookId, ts, body),
        ...(headers.subscriptionId !== undefined ? { "x-mcp-subscription-id": headers.subscriptionId } : {}),
        ...(headers.watcherId !== undefined ? { "x-omb-watcher-id": headers.watcherId } : {}),
      },
    },
    policy,
  );
}

export type ChallengeOutcome = { ok: true } | { ok: false; reason: string; /** The endpoint answered and did not echo the challenge; trying again will not help. */ definitive: boolean };

/**
 * Sends a signed `{"type": "verification", "challenge"}` and looks for a 2xx echo of the challenge (compared in
 * constant time). A transport failure or a 5xx may pass; any other answer without the echo is definitive.
 */
export async function challengeEndpoint(ctx: AppContext, url: URL, secret: string, ids: { watcherId?: string; subscriptionId?: string }, policy: CallbackPolicy): Promise<ChallengeOutcome> {
  const challenge = randomBytes(24).toString("base64url");
  let res: SignedPost;
  try {
    res = await postSigned(ctx, url, JSON.stringify({ type: "verification", challenge }), { webhookId: newWebhookId(), secret, ...ids }, policy);
  } catch (e) {
    return { ok: false, reason: e instanceof CallbackError ? e.reason : "unreachable", definitive: false };
  }
  let echoed = "";
  try {
    echoed = String((JSON.parse(res.body) as { challenge?: unknown }).challenge ?? "");
  } catch {
    echoed = res.body.trim();
  }
  const a = Buffer.from(echoed);
  const b = Buffer.from(challenge);
  if (res.status >= 200 && res.status < 300 && a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  return { ok: false, reason: "challenge_failed", definitive: res.status < 500 };
}

/** `challengeEndpoint` for callers that refuse on any failure. Throws CallbackError with the failure reason. */
export async function verifyChallenge(ctx: AppContext, url: URL, secret: string, ids: { watcherId?: string; subscriptionId?: string }, policy: CallbackPolicy): Promise<void> {
  const outcome = await challengeEndpoint(ctx, url, secret, ids, policy);
  if (!outcome.ok) throw new CallbackError(outcome.reason, outcome.reason === "challenge_failed" ? "The endpoint did not echo the verification challenge" : "The endpoint could not be reached");
}

/** `whsec_` followed by base64 of 24 to 64 bytes. */
export function isWebhookSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  const raw = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const n = Buffer.from(raw, "base64").length;
  return n >= 24 && n <= 64;
}

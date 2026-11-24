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
  timeoutMs = 5000,
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

/**
 * Sends a signed `{"type": "verification", "challenge"}` and requires a 2xx echo of the challenge
 * (compared in constant time). Throws CallbackError with the failure reason.
 */
export async function verifyChallenge(ctx: AppContext, url: URL, secret: string, ids: { watcherId?: string; subscriptionId?: string }, policy: CallbackPolicy): Promise<void> {
  const challenge = randomBytes(24).toString("base64url");
  const res = await postSigned(ctx, url, JSON.stringify({ type: "verification", challenge }), { webhookId: newWebhookId(), secret, ...ids }, policy);
  let echoed = "";
  try {
    echoed = String((JSON.parse(res.body) as { challenge?: unknown }).challenge ?? "");
  } catch {
    echoed = res.body.trim();
  }
  const a = Buffer.from(echoed);
  const b = Buffer.from(challenge);
  if (res.status < 200 || res.status >= 300 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new CallbackError("challenge_failed", "The endpoint did not echo the verification challenge");
  }
}

/** `whsec_` followed by base64 of 24 to 64 bytes. */
export function isWebhookSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  const raw = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const n = Buffer.from(raw, "base64").length;
  return n >= 24 && n <= 64;
}

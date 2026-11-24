import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

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

export interface CallbackPolicy {
  /** Test mode: allow plain HTTP to loopback (for conformance receivers). */
  allowLoopbackHttp: boolean;
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

/** DNS lookup that refuses special-use addresses and pins the approved address for the connection. */
function guardedLookup(policy: CallbackPolicy): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as { address: string; family: number }[];
      const ok = list.find((a) => !isPrivateAddress(a.address) || (policy.allowLoopbackHttp && isLoopbackAddress(a.address)));
      if (!ok || list.some((a) => isPrivateAddress(a.address) && !(policy.allowLoopbackHttp && isLoopbackAddress(a.address)))) {
        return callback(new CallbackError("private_address", `Refusing to call ${hostname}: it resolves to a private address`) as NodeJS.ErrnoException, "", 4);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [ok]);
      callback(null, ok.address, ok.family);
    });
  };
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

export function postSigned(
  url: URL,
  body: string,
  headers: { webhookId: string; secret: string; subscriptionId?: string; watcherId?: string },
  policy: CallbackPolicy,
  timeoutMs = 5000,
): Promise<SignedPost> {
  const ts = Math.floor(Date.now() / 1000);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host) && !(policy.allowLoopbackHttp && isLoopbackAddress(host))) {
      reject(new CallbackError("private_address", "Refusing to call a private address"));
      return;
    }
    const req = send(
      url,
      {
        method: "POST",
        agent: false,
        lookup: guardedLookup(policy),
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "OpenMessageBoard-Webhooks/0.1",
          "webhook-id": headers.webhookId,
          "webhook-timestamp": String(ts),
          "webhook-signature": signWebhook(headers.secret, headers.webhookId, ts, body),
          ...(headers.subscriptionId !== undefined ? { "x-mcp-subscription-id": headers.subscriptionId } : {}),
          ...(headers.watcherId !== undefined ? { "x-omb-watcher-id": headers.watcherId } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (data.length < 65536) data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new CallbackError("timeout", "Callback timed out")));
    req.on("error", (e) => reject(e instanceof CallbackError ? e : new CallbackError("unreachable", e.message)));
    req.end(body);
  });
}

/**
 * Sends a signed `{"type": "verification", "challenge"}` and requires a 2xx echo of the challenge
 * (compared in constant time). Throws CallbackError with the failure reason.
 */
export async function verifyChallenge(url: URL, secret: string, ids: { watcherId?: string; subscriptionId?: string }, policy: CallbackPolicy): Promise<void> {
  const challenge = randomBytes(24).toString("base64url");
  const res = await postSigned(url, JSON.stringify({ type: "verification", challenge }), { webhookId: newWebhookId(), secret, ...ids }, policy);
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

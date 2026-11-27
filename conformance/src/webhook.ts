/**
 * A local webhook receiver on 127.0.0.1 for the Events profile. It answers
 * verification challenges, verifies Standard Webhooks signatures, and records
 * every request. Servers accept plain-HTTP loopback callbacks only in test mode.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Delivery {
  at: number;
  path: string;
  headers: Record<string, string>;
  raw: string;
  body: Record<string, unknown> | undefined;
  /** null when the signature verifies, otherwise why it does not. */
  signatureError: string | null;
}

export type EndpointMode = "echo" | "wrong-challenge";

export class Endpoint {
  readonly deliveries: Delivery[] = [];
  /** Wait this long before answering a delivery (not a verification), to test the sender's timeout. */
  delayMs = 0;
  /** Answer this many deliveries with 500 before accepting, to test retries. */
  failNext = 0;
  private waiters: (() => void)[] = [];
  constructor(
    readonly path: string,
    readonly url: string,
    readonly secret: string,
    public mode: EndpointMode,
  ) {}

  record(d: Delivery): void {
    this.deliveries.push(d);
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async waitFor(match: (d: Delivery) => boolean, timeoutMs: number): Promise<Delivery | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.deliveries.find(match);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

/** A new `whsec_` secret with 32 random bytes. */
export function newWebhookSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

export function verifyStandardWebhook(secret: string, headers: Record<string, string>, raw: string): string | null {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (!id || !ts || !sig) return "missing webhook-id, webhook-timestamp or webhook-signature";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return `webhook-id ${id} has characters outside [A-Za-z0-9_-]`;
  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) return "webhook-timestamp is not integer seconds";
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return "webhook-timestamp is more than 5 minutes from now";
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  const ok = sig.split(" ").some((part) => {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") return false;
    const got = Buffer.from(part.slice(comma + 1), "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return ok ? null : "no v1 signature verifies with the subscription secret";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class WebhookReceiver {
  private endpoints = new Map<string, Endpoint>();
  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  static async start(): Promise<WebhookReceiver> {
    let receiver: WebhookReceiver | undefined;
    const server = createServer((req, res) => {
      void (async () => {
        const raw = await readBody(req).catch(() => "");
        const path = (req.url ?? "/").split("?")[0]!;
        const ep = receiver?.endpoints.get(path);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
        let body: Record<string, unknown> | undefined;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
        if (!ep) {
          res.writeHead(404).end();
          return;
        }
        ep.record({ at: Date.now(), path, headers, raw, body, signatureError: verifyStandardWebhook(ep.secret, headers, raw) });
        if (body?.type === "verification") {
          const challenge = ep.mode === "echo" ? body.challenge : "not-the-challenge";
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge }));
          return;
        }
        if (ep.failNext > 0) {
          ep.failNext--;
          res.writeHead(500).end();
          return;
        }
        if (ep.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, ep.delayMs));
        res.writeHead(204).end();
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    receiver = new WebhookReceiver(server, `http://127.0.0.1:${port}`);
    return receiver;
  }

  endpoint(mode: EndpointMode = "echo"): Endpoint {
    const path = `/hooks/${randomBytes(8).toString("hex")}`;
    const ep = new Endpoint(path, this.origin + path, newWebhookSecret(), mode);
    this.endpoints.set(path, ep);
    return ep;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

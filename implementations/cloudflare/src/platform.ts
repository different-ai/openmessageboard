import { CallbackError, isIP, isLoopbackAddress, isPrivateAddress, type AttachmentStore, type CallbackTransport, type Platform } from "@openmessageboard/core";
import { DurableSqliteDialect } from "./kysely.js";
import { cfWorkerSchemas } from "./schemas.js";
import type { DurableSqlite } from "./sqlite.js";
import type { Env } from "./env.js";

/** Host names that never point at the public internet. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * Outbound calls to user-supplied URLs with fetch: literal private addresses and local names are refused (Workers
 * can't reach private networks anyway, and they don't expose DNS answers to check), redirects are not followed and
 * count as failures, and every call times out.
 */
export const fetchCallbacks: CallbackTransport = {
  async request(url, init, policy) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopbackOk = policy.allowLoopbackHttp && (isLoopbackAddress(host) || host === "localhost");
    if (!loopbackOk && ((isIP(host) && isPrivateAddress(host)) || (!isIP(host) && LOCAL_NAME.test(host)))) {
      throw new CallbackError("private_address", "Refusing to call a private address");
    }
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual", signal });
    } catch (e) {
      if (timeout.aborted) throw new CallbackError("timeout", "Callback timed out");
      throw new CallbackError("unreachable", e instanceof Error ? e.message : "unreachable");
    }
    const body = (await res.text().catch(() => "")).slice(0, 65536);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, body, headers };
  },
};

export class R2AttachmentStore implements AttachmentStore {
  constructor(private readonly bucket: R2Bucket) {}
  async put(key: string, data: Uint8Array): Promise<void> {
    await this.bucket.put(key, data);
  }
  async get(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

/** Attachments in the Durable Object's own SQLite (rows up to 8 MB), for deployments without an R2 bucket. */
export class SqliteAttachmentStore implements AttachmentStore {
  constructor(private readonly db: DurableSqlite) {}
  async put(key: string, data: Uint8Array): Promise<void> {
    this.db.prepare("INSERT INTO cf_attachment_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, data);
  }
  async get(key: string): Promise<Uint8Array | null> {
    const row = this.db.prepare("SELECT data FROM cf_attachment_blobs WHERE key = ?").get(key) as { data: ArrayBuffer } | undefined;
    return row ? new Uint8Array(row.data) : null;
  }
  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM cf_attachment_blobs WHERE key = ?").run(key);
  }
}

export function cloudflarePlatform(env: Env, db: DurableSqlite): Platform {
  return {
    name: "cloudflare",
    callbacks: fetchCallbacks,
    attachments: env.ATTACHMENTS ? new R2AttachmentStore(env.ATTACHMENTS) : new SqliteAttachmentStore(db),
    authDatabase: { dialect: new DurableSqliteDialect(db), type: "sqlite" },
    schemas: cfWorkerSchemas,
  };
}

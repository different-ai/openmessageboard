import { lookup } from "node:dns";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { CallbackError, isIP, isLoopbackAddress, isPrivateAddress, type AttachmentStore, type CallbackPolicy, type CallbackTransport, type Platform } from "@openmessageboard/core";

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

/**
 * node:http transport for user-supplied URLs: resolves the host itself, refuses special-use addresses, connects only
 * to the address it checked (no DNS rebinding), uses no connection pool, follows no redirects and times out.
 */
export const nodeCallbacks: CallbackTransport = {
  request(url, init, policy) {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolvePromise, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isPrivateAddress(host) && !(policy.allowLoopbackHttp && isLoopbackAddress(host))) {
        reject(new CallbackError("private_address", "Refusing to call a private address"));
        return;
      }
      const req = send(
        url,
        {
          method: init.method,
          agent: false,
          lookup: guardedLookup(policy),
          timeout: init.timeoutMs,
          ...(init.signal ? { signal: init.signal } : {}),
          headers: { ...init.headers, ...(init.body !== undefined ? { "content-length": Buffer.byteLength(init.body) } : {}) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (data.length < 65536) data += chunk;
          });
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
            resolvePromise({ status: res.statusCode ?? 0, body: data, headers });
          });
        },
      );
      req.on("timeout", () => req.destroy(new CallbackError("timeout", "Callback timed out")));
      req.on("error", (e) => reject(e instanceof CallbackError ? e : new CallbackError("unreachable", e.message)));
      req.end(init.body);
    });
  },
};

/** Attachment bytes as files under a root directory (mode 0600). */
export class FileAttachmentStore implements AttachmentStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(key)) throw new Error("bad attachment key");
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("bad attachment key");
    return p;
  }
  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** The Node platform: node:http callbacks and files under `$OMB_DATA_DIR/attachments`. */
export function nodePlatform(dataDir: string): Platform {
  return { name: "node", callbacks: nodeCallbacks, attachments: new FileAttachmentStore(join(dataDir, "attachments")) };
}

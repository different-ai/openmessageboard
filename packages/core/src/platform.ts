import type { AttachmentStore } from "./domain/attachments.js";

/** Rules for calling a URL that a user supplied (webhook callbacks, OIDC issuers). */
export interface CallbackPolicy {
  /** Test mode: allow plain HTTP to loopback (for conformance receivers). */
  allowLoopbackHttp: boolean;
}

export interface CallbackResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Outbound HTTP to user-supplied URLs. An implementation must refuse private, loopback (unless the policy allows
 * it), link-local and metadata addresses, follow no redirects, and give up after `timeoutMs`. It throws
 * `CallbackError` (from `mcp/webhook-http`) with a reason such as `timeout`, `unreachable` or `private_address`.
 */
export interface CallbackTransport {
  request(url: URL, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal }, policy: CallbackPolicy): Promise<CallbackResponse>;
}

/** A JSON Schema (draft-07) engine for registered data schemas. */
export interface SchemaEngine {
  /** Throws an Error saying why, if `schema` is not a valid JSON Schema. */
  check(schema: Record<string, unknown>): void;
  /** Compiles a validator that returns the problems it finds (none when the data is valid). */
  compile(schema: Record<string, unknown>): (data: unknown) => { path: string; message: string }[];
}

/**
 * What a runtime provides to the core. The Node implementation backs these with node:http, the filesystem and
 * better-sqlite3; the Cloudflare implementation with fetch, R2 and Durable Object SQLite.
 */
export interface Platform {
  /** Short name reported in discovery, such as "node" or "cloudflare". */
  readonly name: string;
  readonly callbacks: CallbackTransport;
  readonly attachments: AttachmentStore;
  /** The `database` option for Better Auth. Defaults to the core database handle. */
  readonly authDatabase?: unknown;
  /** JSON Schema engine. Defaults to Ajv, which compiles validators to code (not allowed on Workers). */
  readonly schemas?: SchemaEngine;
}

function missing(what: string): never {
  throw new Error(`This runtime has no ${what} configured (Platform.${what})`);
}

/** A platform for contexts that never make outbound calls or store files (unit tests). */
export const NO_PLATFORM: Platform = {
  name: "none",
  callbacks: { request: () => missing("callbacks") },
  attachments: { put: () => missing("attachments"), get: () => missing("attachments"), delete: () => missing("attachments") },
};

/** Bindings and variables (wrangler.jsonc `vars`, secrets such as OMB_SECRET). */
export interface Env {
  /** The Durable Object that runs the board server. */
  BOARD: DurableObjectNamespace;
  /** Static files of the browser client (Workers static assets). */
  ASSETS?: Fetcher;
  /** Attachment bytes. Without it, attachments are kept in the Durable Object's SQLite. */
  ATTACHMENTS?: R2Bucket;
  /** Cloudflare Email Service, for sign-in codes. Without it, codes are written to the Worker log. */
  EMAIL?: SendEmail;
  /** The site's newsletter database (D1). With it, sign-in offers the newsletter and Settings shows the choice. */
  NEWSLETTER?: D1Database;
  /** Test mode only: a shared secret for POST /x/test/identities. */
  OMB_TEST_ADMIN_TOKEN?: string;
  [name: string]: unknown;
}

/** The string variables, as the core's configuration reads them. */
export function stringVars(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

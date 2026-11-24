import { OmbError } from "./errors.js";

export interface TokenContext {
  /** The OpenMessageBoard server base URL (no trailing slash). Workload identity uses it as the default audience. */
  server: string;
  /** True after the server answered 401: drop any cached token and fetch a fresh one. */
  forceRefresh?: boolean;
}

/**
 * Supplies the bearer token for each request. Return `undefined` to send no token.
 * Called before every request, so implementations should cache.
 */
export type TokenProvider = (ctx: TokenContext) => string | undefined | Promise<string | undefined>;

/** A fixed token, such as a personal access token or an agent token. */
export function staticToken(token: string): TokenProvider {
  return () => token;
}

/** Reads a token from an environment variable on each request (default `OMB_TOKEN`). */
export function envToken(name = "OMB_TOKEN", env: NodeJS.ProcessEnv = process.env): TokenProvider {
  return () => {
    const value = env[name]?.trim();
    if (!value) throw new OmbError("unauthenticated", `${name} is not set`);
    return value;
  };
}

/** Seconds since epoch at which a JWT expires, or undefined if it cannot be read. Does not verify anything. */
export function jwtExpiry(jwt: string): number | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Caches a token until shortly before its JWT `exp` (or for `fallbackTtlMs` when it has none). */
function cached(fetchToken: (ctx: TokenContext) => Promise<string>, fallbackTtlMs = 5 * 60_000): TokenProvider {
  let token: string | undefined;
  let expiresAt = 0;
  let inflight: Promise<string> | undefined;
  return async (ctx) => {
    if (!ctx.forceRefresh && token && Date.now() < expiresAt) return token;
    inflight ??= fetchToken(ctx).finally(() => {
      inflight = undefined;
    });
    const fresh = await inflight;
    const exp = jwtExpiry(fresh);
    token = fresh;
    expiresAt = exp ? exp * 1000 - 60_000 : Date.now() + fallbackTtlMs;
    return fresh;
  };
}

export interface GithubActionsOidcOptions {
  /** Audience to request. Must match the audience in the board's workload trust. Default: the server URL. */
  audience?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/**
 * Workload identity for GitHub Actions: requests an OIDC ID token for the job and sends it as the bearer token.
 * The workflow needs `permissions: id-token: write`. No secret is stored anywhere.
 */
export function githubActionsOidc(options: GithubActionsOidcOptions = {}): TokenProvider {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  return cached(async (ctx) => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !requestToken) {
      throw new OmbError(
        "unauthenticated",
        "GitHub Actions OIDC is unavailable: ACTIONS_ID_TOKEN_REQUEST_URL is not set. Add `permissions: id-token: write` to the workflow or job.",
      );
    }
    const audience = options.audience ?? ctx.server;
    const sep = url.includes("?") ? "&" : "?";
    let res: Response;
    try {
      res = await doFetch(`${url}${sep}audience=${encodeURIComponent(audience)}`, {
        headers: { Authorization: `bearer ${requestToken}`, Accept: "application/json" },
      });
    } catch (err) {
      throw new OmbError("network", "Could not reach the GitHub Actions token service", undefined, { cause: err });
    }
    if (!res.ok) throw new OmbError("unauthenticated", `GitHub Actions token request failed (HTTP ${res.status})`, { status: res.status });
    const body = (await res.json()) as { value?: unknown };
    if (typeof body.value !== "string" || !body.value) throw new OmbError("unauthenticated", "GitHub Actions returned no ID token");
    return body.value;
  });
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export interface VercelOidcOptions {
  /**
   * Request headers of the current invocation (`x-vercel-oidc-token`), or a function returning them.
   * When omitted, the Vercel request context is consulted, then `VERCEL_OIDC_TOKEN`.
   */
  headers?: HeaderSource | (() => HeaderSource | undefined);
  env?: NodeJS.ProcessEnv;
}

function readHeader(source: HeaderSource | undefined, name: string): string | undefined {
  if (!source) return undefined;
  if (typeof (source as Headers).get === "function") return (source as Headers).get(name) ?? undefined;
  const value = (source as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Headers Vercel's runtime exposes for the current request, when running on Vercel Functions. */
function vercelRequestContextHeaders(): HeaderSource | undefined {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    | { get?: () => { headers?: HeaderSource } | undefined }
    | undefined;
  try {
    return ctx?.get?.()?.headers;
  } catch {
    return undefined;
  }
}

/**
 * Workload identity for Vercel: uses the deployment's OIDC token. At runtime Vercel sends it on each request as
 * the `x-vercel-oidc-token` header; during builds (and `vercel env pull` locally) it is `VERCEL_OIDC_TOKEN`.
 */
export function vercelOidc(options: VercelOidcOptions = {}): TokenProvider {
  const env = options.env ?? process.env;
  return () => {
    const headers = typeof options.headers === "function" ? options.headers() : options.headers;
    const token =
      readHeader(headers, "x-vercel-oidc-token") ??
      readHeader(vercelRequestContextHeaders(), "x-vercel-oidc-token") ??
      env.VERCEL_OIDC_TOKEN;
    if (!token) {
      throw new OmbError(
        "unauthenticated",
        "Vercel OIDC is unavailable: no x-vercel-oidc-token header and VERCEL_OIDC_TOKEN is not set. Enable OIDC federation for the project.",
      );
    }
    return token;
  };
}

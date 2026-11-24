/**
 * Workload identity: a deployment (GitHub Actions, Vercel, GitLab, Google, any OIDC issuer) signs in with the
 * ID token its platform already gives it and acts as a named agent principal. No secret is stored.
 *
 * A board owner creates a trust (issuer, audience, subject pattern, extra claims). Creating it also creates an
 * agent owned by that person and adds it to the board. A bearer JWT whose signature verifies against the
 * issuer's published keys and whose claims match the trust authenticates as that agent.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type FetchImplementation, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { CreateWorkloadTrustBody, type WorkloadTrust } from "@openmessageboard/protocol";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { actorFromPrincipal, getPrincipal, nowIso, requireHuman, requireMember } from "../domain/access.js";
import { addManagedMember, removeMembershipCascade } from "../domain/boards.js";
import type { Actor, PrincipalRow } from "../domain/model.js";
import { parseBody, requireActor, type RouteModule } from "../http/util.js";

// ---------- storage ----------

interface TrustRow {
  id: string;
  board_id: string;
  issuer: string;
  audience: string;
  subject_pattern: string;
  claims: string;
  agent_id: string;
  role: "reader" | "contributor";
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

type TrustWithAgent = TrustRow & { agent_name: string };

const SELECT_TRUST = "SELECT t.*, p.display_name AS agent_name FROM workload_trusts t JOIN principals p ON p.id = t.agent_id";

function present(row: TrustWithAgent): WorkloadTrust {
  return {
    id: row.id,
    board_id: row.board_id,
    issuer: row.issuer,
    audience: row.audience,
    subject_pattern: row.subject_pattern,
    claims: parseClaims(row.claims),
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    role: row.role,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

function parseClaims(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  } catch {
    /* fall through */
  }
  return {};
}

// ---------- validation ----------

const MAX_PATTERN = 512;
const MAX_AUDIENCE = 512;
const MAX_CLAIMS = 16;
/** Checked by the verifier itself; listing them as extra claims would be misleading. */
const RESERVED_CLAIMS = new Set(["iss", "aud", "sub", "exp", "iat", "nbf", "jti"]);

function validateIssuer(ctx: AppContext, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("issuer must be a URL");
  }
  if (url.protocol !== "https:" && !(ctx.config.testMode && url.protocol === "http:")) throw invalid("issuer must use https");
  if (url.username || url.password || url.search || url.hash) throw invalid("issuer must not contain credentials, a query or a fragment");
  // Keep the issuer exactly as given: `iss` is compared byte for byte, and some issuers end with a slash.
  if (raw.replace(/\/+$/, "") === ctx.config.publicUrl.replace(/\/+$/, "")) throw invalid("issuer can't be this server");
  return raw;
}

function validateInput(ctx: AppContext, input: z.infer<typeof CreateWorkloadTrustBody>) {
  const issuer = validateIssuer(ctx, input.issuer.trim());
  const subject = input.subject_pattern.trim();
  if (!subject) throw invalid("subject_pattern must not be empty");
  if (/^\*+$/.test(subject)) throw invalid("subject_pattern must name a subject; a bare * would trust every workload of this issuer");
  if (subject.length > MAX_PATTERN) throw invalid(`subject_pattern must be at most ${MAX_PATTERN} characters`);
  const audience = (input.audience ?? ctx.config.publicUrl).trim();
  if (!audience || audience.length > MAX_AUDIENCE) throw invalid(`audience must be 1-${MAX_AUDIENCE} characters`);
  const claims = input.claims ?? {};
  const entries = Object.entries(claims);
  if (entries.length > MAX_CLAIMS) throw invalid(`At most ${MAX_CLAIMS} extra claims`);
  for (const [k, v] of entries) {
    if (!k || k.length > 100) throw invalid("Claim names must be 1-100 characters");
    if (RESERVED_CLAIMS.has(k)) throw invalid(`"${k}" is checked automatically; use issuer, audience or subject_pattern instead`);
    if (typeof v !== "string" || v.length > MAX_PATTERN) throw invalid(`Claim "${k}" must be a string of at most ${MAX_PATTERN} characters`);
  }
  const agentName = input.agent_name.trim();
  if (!agentName || agentName.length > 60) throw invalid("agent_name must be 1-60 characters");
  return { issuer, subject, audience, claims, agentName };
}

// ---------- domain ----------

export function listWorkloadTrusts(ctx: AppContext, actor: Actor, boardId: string): WorkloadTrust[] {
  requireMember(ctx, actor, boardId, "owner");
  const rows = ctx.db.prepare(`${SELECT_TRUST} WHERE t.board_id = ? ORDER BY t.created_at, t.id`).all(boardId) as TrustWithAgent[];
  return rows.map(present);
}

export function createWorkloadTrust(ctx: AppContext, actor: Actor, boardId: string, input: z.infer<typeof CreateWorkloadTrustBody>): WorkloadTrust {
  requireHuman(actor);
  const v = validateInput(ctx, input);
  return tx(ctx, (emit) => {
    requireMember(ctx, actor, boardId, "owner");
    // Each trust creates an agent principal; share the per-person write allowance so create/delete loops stay bounded.
    ctx.rate.hit(`w:p:${actor.id}`, ctx.config.rateLimits.writes_per_minute_principal, 60_000);
    const now = nowIso(ctx);
    const agentId = newId("p");
    ctx.db
      .prepare("INSERT INTO principals (id, kind, display_name, email, owner_id, created_at) VALUES (?, 'agent', ?, NULL, ?, ?)")
      .run(agentId, v.agentName, actor.id, now);
    addManagedMember(ctx, emit, boardId, getPrincipal(ctx, agentId)!, input.role, actor.id);
    const id = newId("wlt");
    ctx.db
      .prepare(
        `INSERT INTO workload_trusts (id, board_id, issuer, audience, subject_pattern, claims, agent_id, role, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, boardId, v.issuer, v.audience, v.subject, JSON.stringify(v.claims), agentId, input.role, actor.id, now);
    return present(ctx.db.prepare(`${SELECT_TRUST} WHERE t.id = ?`).get(id) as TrustWithAgent);
  });
}

export function deleteWorkloadTrust(ctx: AppContext, actor: Actor, trustId: string): void {
  tx(ctx, (emit) => {
    const trust = ctx.db.prepare("SELECT * FROM workload_trusts WHERE id = ?").get(trustId) as TrustRow | undefined;
    if (!trust) throw notFound("Workload trust");
    requireMember(ctx, actor, trust.board_id, "owner", "Workload trust");
    ctx.db.prepare("DELETE FROM workload_trusts WHERE id = ?").run(trust.id);
    removeMembershipCascade(ctx, emit, trust.board_id, trust.agent_id, actor.id, "removed");
  });
}

// ---------- routes ----------

export const registerWorkloadRoutes: RouteModule = (app, ctx) => {
  app.get("/api/boards/:boardId/workload-trusts", (c) => {
    return c.json({ trusts: listWorkloadTrusts(ctx, requireActor(c), c.req.param("boardId")) });
  });
  app.post("/api/boards/:boardId/workload-trusts", async (c) => {
    const actor = requireActor(c);
    const body = await parseBody(c, CreateWorkloadTrustBody);
    return c.json({ trust: createWorkloadTrust(ctx, actor, c.req.param("boardId"), body) }, 201);
  });
  app.delete("/api/workload-trusts/:trustId", (c) => {
    deleteWorkloadTrust(ctx, requireActor(c), c.req.param("trustId"));
    return c.json({ deleted: true });
  });
};

// ---------- token verification ----------

const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface IssuerKeys {
  expiresAt: number;
  keys: Promise<JWTVerifyGetKey>;
}

/** Per-context so separate servers (and tests) in one process never share keys. */
const issuerCache = new WeakMap<AppContext, Map<string, IssuerKeys>>();

/**
 * Resolves a bearer token to the agent of a matching workload trust, or null.
 * Never throws: an unverifiable token is simply not a workload token. Logs the issuer only, never the token.
 */
export async function verifyWorkloadToken(ctx: AppContext, token: string): Promise<Actor | null> {
  if (token.length > MAX_TOKEN_CHARS || !JWT_SHAPE.test(token)) return null;
  let issuer: string;
  try {
    const iss = decodeJwt(token).iss;
    if (typeof iss !== "string" || !iss) return null;
    issuer = iss;
  } catch {
    return null;
  }
  // Only issuers some board owner named are ever contacted.
  if (!ctx.db.prepare("SELECT 1 FROM workload_trusts WHERE issuer = ? LIMIT 1").get(issuer)) return null;

  try {
    const audiences = (ctx.db.prepare("SELECT DISTINCT audience FROM workload_trusts WHERE issuer = ?").all(issuer) as { audience: string }[]).map((r) => r.audience);
    const keys = await keysFor(ctx, issuer);
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: audiences,
      algorithms: ALGORITHMS,
      clockTolerance: 60,
      maxTokenAge: 3600,
      requiredClaims: ["exp", "iat", "sub"],
      currentDate: ctx.now(),
    });
    const trust = matchTrust(ctx, issuer, payload);
    if (!trust) {
      logRejection(issuer, "no_matching_trust");
      return null;
    }
    const agent = getPrincipal(ctx, trust.agent_id);
    if (!agent || agent.kind !== "agent" || agent.disabled_at || !ownerActive(ctx, agent)) return null;
    const now = ctx.now();
    ctx.db
      .prepare("UPDATE workload_trusts SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .run(now.toISOString(), trust.id, new Date(now.getTime() - 60_000).toISOString());
    return actorFromPrincipal(agent, "workload");
  } catch (e) {
    const code = errorCode(e);
    if (!isTokenRejection(code)) markIssuerFailed(ctx, issuer);
    logRejection(issuer, code);
    return null;
  }
}

/** Failures that say something about the token rather than about reaching the issuer. */
function isTokenRejection(code: string): boolean {
  return (
    code.startsWith("ERR_JWT") ||
    code.startsWith("ERR_JWS") ||
    ["ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS", "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED"].includes(code)
  );
}

/** After a failed key fetch, stop contacting the issuer for a minute instead of fetching once per presented token. */
function markIssuerFailed(ctx: AppContext, issuer: string): void {
  const keys = Promise.reject(new WorkloadError("issuer_unavailable"));
  keys.catch(() => {});
  issuerCache.get(ctx)?.set(issuer, { expiresAt: Date.now() + DISCOVERY_FAILURE_TTL_MS, keys });
}

function ownerActive(ctx: AppContext, agent: PrincipalRow): boolean {
  if (!agent.owner_id) return false;
  const owner = getPrincipal(ctx, agent.owner_id);
  return !!owner && !owner.disabled_at;
}

function matchTrust(ctx: AppContext, issuer: string, payload: JWTPayload): TrustRow | undefined {
  const tokenAud = new Set(typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []));
  const sub = payload.sub ?? "";
  const rows = ctx.db.prepare("SELECT * FROM workload_trusts WHERE issuer = ? ORDER BY created_at, id").all(issuer) as TrustRow[];
  return rows.find((t) => {
    if (!tokenAud.has(t.audience)) return false;
    if (!subjectMatches(t.subject_pattern, sub)) return false;
    for (const [k, expected] of Object.entries(parseClaims(t.claims))) {
      const actual = (payload as Record<string, unknown>)[k];
      const text = typeof actual === "string" ? actual : typeof actual === "number" || typeof actual === "boolean" ? String(actual) : undefined;
      if (text !== expected) return false;
    }
    return true;
  });
}

/** `*` matches any run of characters; everything else is literal. The whole subject must match. */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (!pattern.includes("*")) return pattern === subject;
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(subject);
}

async function keysFor(ctx: AppContext, issuer: string): Promise<JWTVerifyGetKey> {
  let cache = issuerCache.get(ctx);
  if (!cache) issuerCache.set(ctx, (cache = new Map()));
  const hit = cache.get(issuer);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;
  const entry: IssuerKeys = { expiresAt: Date.now() + DISCOVERY_TTL_MS, keys: discover(ctx, issuer) };
  cache.set(issuer, entry);
  entry.keys.catch(() => {
    // Remember a failure briefly so a broken or hostile issuer can't be made to receive a request per token.
    entry.expiresAt = Math.min(entry.expiresAt, Date.now() + DISCOVERY_FAILURE_TTL_MS);
  });
  return entry.keys;
}

async function discover(ctx: AppContext, issuer: string): Promise<JWTVerifyGetKey> {
  const fetcher = guardedFetch(ctx);
  const url = issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const res = await fetcher(url, { headers: new Headers({ accept: "application/json" }), method: "GET", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) throw new WorkloadError("discovery_failed");
  const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
  // OpenID Connect Discovery 1.0 §4.3: the document must name exactly the issuer it was fetched for.
  if (doc.issuer !== issuer) throw new WorkloadError("discovery_issuer_mismatch");
  if (typeof doc.jwks_uri !== "string") throw new WorkloadError("discovery_no_jwks_uri");
  const jwksUri = new URL(doc.jwks_uri);
  assertScheme(ctx, jwksUri);
  return createRemoteJWKSet(jwksUri, {
    timeoutDuration: FETCH_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: DISCOVERY_TTL_MS,
    [customFetch]: fetcher,
  });
}

class WorkloadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function errorCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
  return "error";
}

const lastLogged = new Map<string, number>();
function logRejection(issuer: string, code: string): void {
  const key = `${issuer} ${code}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? 0) > now - 60_000) return;
  lastLogged.set(key, now);
  if (lastLogged.size > 1000) lastLogged.clear();
  console.warn(`workload identity: rejected a token from ${issuer} (${code})`);
}

// ---------- outbound requests to issuers ----------

function assertScheme(ctx: AppContext, url: URL): void {
  if (url.protocol === "https:") return;
  if (ctx.config.testMode && url.protocol === "http:") return;
  throw new WorkloadError("insecure_url");
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Private, loopback, link-local, metadata and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  return blocked.check(address, "ipv6");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * GET with no redirects, a size cap and a timeout. Outside test mode only https is allowed, and every resolved
 * address is checked at connect time, so a DNS answer can't point the request at the host's private network.
 */
function guardedFetch(ctx: AppContext): FetchImplementation {
  const allowPrivate = ctx.config.testMode;
  return (resource, options) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(resource);
        assertScheme(ctx, url);
      } catch (e) {
        reject(e);
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!allowPrivate && isIP(host) && isBlockedAddress(host)) {
        reject(new WorkloadError("blocked_address"));
        return;
      }
      const lookup = (hostname: string, opts: { all?: boolean; family?: number }, cb: LookupCallback) => {
        dnsLookup(hostname, { family: opts.family ?? 0, all: true }, (err, addresses) => {
          if (err) return cb(err, []);
          const list = addresses as LookupAddress[];
          if (list.length === 0 || (!allowPrivate && list.some((a) => isBlockedAddress(a.address)))) {
            return cb(Object.assign(new Error("Issuer resolves to a non-public address"), { code: "EBLOCKED" }), []);
          }
          if (opts.all) cb(null, list);
          else cb(null, list[0]!.address, list[0]!.family);
        });
      };
      const headers: Record<string, string> = { "user-agent": "OpenMessageBoard workload identity" };
      options.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const requestOptions: RequestOptions = { method: "GET", headers, signal: options.signal, lookup: lookup as RequestOptions["lookup"], timeout: FETCH_TIMEOUT_MS };
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, requestOptions, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            req.destroy(new WorkloadError("document_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            reject(new WorkloadError("bad_status"));
            return;
          }
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") responseHeaders.set(k, v);
          }
          const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers: responseHeaders }));
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new WorkloadError("timeout")));
      req.on("error", reject);
      req.end();
    });
}

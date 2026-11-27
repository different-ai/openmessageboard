/**
 * A delegation gateway: an RFC 8693 token endpoint and a DPoP-checking front for the MCP endpoint of an
 * unmodified OpenMessageBoard server. It exists to try proposal 0006 over the wire before the server changes.
 *
 * A delegation is one record: the person it acts for, the agent that holds it, the delegation it came from,
 * the key it is bound to, what it may do and until when. The agent gets a signed access token that names all of
 * that (`sub`, `act`, `cnf.jkt`, `authorization_details`) and is useless without the key. Upstream, each
 * delegation is a scoped token of the person, writing as a profile, that never leaves this process.
 *
 * Development only. The gateway keeps the person's token in memory while a root delegation lives, so that it
 * can create the upstream token for an agent that agent starts. A server that implements the proposal keeps no
 * such thing; see README.md for what else this does and does not prove.
 */
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT, EmbeddedJWK, calculateJwkThumbprint, exportJWK, generateKeyPair, jwtVerify, type JWK } from "jose";
import { ACTOR_TYP, DELEGATION_TYP, DETAIL_TYPE, GRANT_TOKEN_EXCHANGE, PERMISSIONS, TYPE_ACCESS_TOKEN, TYPE_JWT, htuOf, sha256url, type BoardAccess, type Permission } from "./agent.js";

/** The most levels of agents a person can let an agent start: a person's agent, an agent it starts, and one more. */
export const MAX_SUB_AGENTS = 2;
/** Live delegations per person, so an agent can't start agents without end. */
export const MAX_ACTIVE_PER_PERSON = 50;
const DEFAULT_SECONDS = 3600;
/** A proof, actor token or assertion is accepted for this long after it was issued; its `jti` is remembered for twice that. */
const PROOF_WINDOW_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;

export interface Actor {
  /** The agent's principal ID on the board server. */
  sub: string;
  /** The agent that started this one (RFC 8693 §4.1: nested `act` is a prior actor). */
  act?: Actor;
}

interface Delegation {
  id: string;
  person: { id: string; display_name: string };
  agent: { id: string; name: string };
  parent: Delegation | null;
  jkt: string;
  /** SHA-256 of the access token, which is how a delegation assertion names the delegation it comes from. */
  ath: string;
  actions: Permission[];
  boards: string[] | null;
  /** How many levels of agents this one may start. */
  subAgents: number;
  expiresAt: number;
  revokedAt: number | null;
  /** The upstream scoped token this delegation acts with. Never sent to anyone. */
  upstreamToken: string;
  /** Root delegations only: the person's token, kept to create upstream tokens for descendants. */
  personToken: string | null;
  /** Requests in flight, aborted when the delegation is revoked. */
  open: Set<AbortController>;
}

export interface DelegationView {
  id: string;
  person: { id: string; display_name: string };
  agent: { id: string; name: string };
  parent: string | null;
  jkt: string;
  actions: Permission[];
  boards: string[] | null;
  sub_agents: number;
  expires_at: string;
  revoked: boolean;
}

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly challenge = false,
  ) {
    super(message);
  }
}
const bad = (code: string, message: string) => new OAuthError(400, code, message);
/** A refusal at the protected resource: 401 with a DPoP challenge (RFC 9449 §7.1). */
const denied = (code: string, message: string) => new OAuthError(401, code, message, true);

export interface Gateway {
  fetch(req: Request): Promise<Response>;
  /** Every delegation of every person, newest last (for tests and the demo). */
  list(): DelegationView[];
}

export async function createGateway(opts: { upstream: string; publicUrl: string; now?: () => number }): Promise<Gateway> {
  const upstream = opts.upstream.replace(/\/$/, "");
  const issuer = opts.publicUrl.replace(/\/$/, "");
  const now = opts.now ?? Date.now;
  const tokenEndpoint = `${issuer}/token`;
  const resource = `${issuer}/mcp`;

  const signing = await generateKeyPair("ES256", { extractable: false });
  const publicJwk: JWK = { ...(await exportJWK(signing.publicKey)), alg: "ES256", use: "sig" };
  publicJwk.kid = await calculateJwkThumbprint(publicJwk, "sha256");

  const delegations = new Map<string, Delegation>();
  const seenJti = new Map<string, number>();

  // ---- the upstream board server, reached only through its MCP endpoint

  async function upstreamCall<T>(token: string, tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
    const client = new Client({ name: "delegation-gateway", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${upstream}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }));
    try {
      const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
      if (result.isError) {
        const error = (result.structuredContent as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw bad("invalid_authorization_details", `The board server refused: ${error?.code ?? "error"}${error?.message ? ` (${error.message})` : ""}`);
      }
      return result.structuredContent as T;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  interface WhoAmI {
    principal: { id: string; kind: string; display_name: string; scope?: unknown; profile?: string | null };
  }

  // ---- delegations

  const expired = (d: Delegation) => d.expiresAt <= now();
  /** A delegation is live only while it and every delegation above it are neither revoked nor expired. */
  function live(d: Delegation): boolean {
    for (let cur: Delegation | null = d; cur; cur = cur.parent) if (cur.revokedAt !== null || expired(cur)) return false;
    return true;
  }
  const rootOf = (d: Delegation): Delegation => (d.parent ? rootOf(d.parent) : d);
  const actorOf = (d: Delegation): Actor => (d.parent ? { sub: d.agent.id, act: actorOf(d.parent) } : { sub: d.agent.id });
  const descends = (d: Delegation, ancestor: Delegation): boolean => {
    for (let cur: Delegation | null = d; cur; cur = cur.parent) if (cur === ancestor) return true;
    return false;
  };
  const view = (d: Delegation): DelegationView => ({
    id: d.id,
    person: d.person,
    agent: d.agent,
    parent: d.parent?.id ?? null,
    jkt: d.jkt,
    actions: d.actions,
    boards: d.boards,
    sub_agents: d.subAgents,
    expires_at: new Date(d.expiresAt).toISOString(),
    revoked: !live(d),
  });

  /** Revokes a delegation and, because `live` walks upward, everything started from it. Open requests are cut. */
  function revoke(target: Delegation): void {
    if (target.revokedAt === null) target.revokedAt = now();
    for (const d of delegations.values()) {
      if (!descends(d, target)) continue;
      for (const controller of d.open) controller.abort();
      d.open.clear();
    }
    if (!target.parent) target.personToken = null;
  }

  // ---- proofs

  /** Remembers a `jti` for the proof window; false when it was already used (RFC 9449 §11.1). */
  function firstUse(jti: string): boolean {
    const t = now();
    for (const [key, until] of seenJti) if (until <= t) seenJti.delete(key);
    if (seenJti.has(jti)) return false;
    seenJti.set(jti, t + 2 * PROOF_WINDOW_SECONDS * 1000);
    return true;
  }

  const jwtChecks = () => ({ algorithms: ["ES256"], currentDate: new Date(now()), maxTokenAge: PROOF_WINDOW_SECONDS, clockTolerance: CLOCK_SKEW_SECONDS });

  /**
   * RFC 9449 §4.3: one proof, for this method and URL, fresh and unused, and for this token when one is
   * presented. Returns the thumbprint of the key that signed it; the caller decides which key that must be.
   */
  async function proofKey(req: Request, url: string, accessToken?: string): Promise<string> {
    const proof = req.headers.get("dpop");
    if (!proof || proof.includes(",")) throw denied("invalid_dpop_proof", "Send exactly one DPoP proof");
    let claims: Record<string, unknown>;
    let jkt: string;
    try {
      const verified = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", ...jwtChecks() });
      claims = verified.payload;
      jkt = await calculateJwkThumbprint(verified.protectedHeader.jwk as JWK, "sha256");
    } catch {
      throw denied("invalid_dpop_proof", "The DPoP proof is not a valid, recent ES256 proof");
    }
    if (claims.htm !== req.method || claims.htu !== htuOf(url)) throw denied("invalid_dpop_proof", "The DPoP proof is for another request");
    if (accessToken !== undefined && claims.ath !== sha256url(accessToken)) throw denied("invalid_dpop_proof", "The DPoP proof is for another token");
    if (typeof claims.jti !== "string" || !firstUse(`dpop:${jkt}:${claims.jti}`)) throw denied("invalid_dpop_proof", "The DPoP proof was already used");
    return jkt;
  }

  /** A request that presents a key-bound token: the proof must come from the key the token is bound to. */
  async function checkProof(req: Request, url: string, accessToken: string, jkt: string): Promise<void> {
    if ((await proofKey(req, url, accessToken)) !== jkt) throw denied("invalid_token", "The token is bound to another key");
  }

  /** The live delegation an access token names, or null when the token isn't one of ours or is dead. */
  async function delegationOf(accessToken: string): Promise<Delegation | null> {
    try {
      const { payload } = await jwtVerify(accessToken, signing.publicKey, { typ: "at+jwt", algorithms: ["ES256"], issuer, audience: resource, currentDate: new Date(now()) });
      const d = delegations.get(String(payload.jti));
      return d && live(d) ? d : null;
    } catch {
      return null;
    }
  }

  // ---- the token endpoint (RFC 8693)

  interface Wanted {
    actions: Permission[];
    boards: string[] | null;
    endsAt: number | null;
    subAgents: number;
  }

  function parseAccess(details: unknown): Wanted {
    const d = Array.isArray(details) && details.length === 1 ? (details[0] as Partial<BoardAccess>) : null;
    if (!d || d.type !== DETAIL_TYPE) throw bad("invalid_authorization_details", `Send one authorization detail of type ${DETAIL_TYPE}`);
    const actions = [...new Set(d.actions ?? [])];
    const readOnly = actions.length === 1 && actions[0] === "read";
    const all = actions.length === PERMISSIONS.length && PERMISSIONS.every((p) => actions.includes(p));
    if (!readOnly && !all) throw bad("invalid_authorization_details", 'actions is ["read"], or ["read", "post", "react", "label"]');
    const boards = d.boards === undefined ? null : [...new Set(d.boards)];
    if (boards && (boards.length === 0 || boards.some((b) => typeof b !== "string"))) throw bad("invalid_authorization_details", "boards is a list of board IDs");
    const endsAt = d.access_ends_at === undefined ? null : Date.parse(d.access_ends_at);
    if (endsAt !== null && (Number.isNaN(endsAt) || endsAt <= now())) throw bad("invalid_authorization_details", "access_ends_at is an instant in the future");
    const subAgents = d.sub_agents ?? 0;
    if (!Number.isInteger(subAgents) || subAgents < 0 || subAgents > MAX_SUB_AGENTS) throw bad("invalid_authorization_details", `sub_agents is a whole number from 0 to ${MAX_SUB_AGENTS}`);
    return { actions: readOnly ? ["read"] : [...PERMISSIONS], boards, endsAt, subAgents };
  }

  async function exchange(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    if (form.get("grant_type") !== GRANT_TOKEN_EXCHANGE) throw bad("unsupported_grant_type", "Only token exchange is offered here");
    if (form.has("resource") && form.get("resource") !== resource) throw bad("invalid_target", `This gateway issues tokens for ${resource} only`);

    // The key the new token will be bound to: the one that signed the request's DPoP proof (RFC 9449 §5).
    const jkt = await proofKey(req, tokenEndpoint).catch((e: OAuthError) => {
      throw bad("invalid_dpop_proof", e.message);
    });

    // The new agent: its name, stated with that same key.
    if (form.get("actor_token_type") !== TYPE_JWT) throw bad("invalid_request", "actor_token is a JWT signed by the new agent's key");
    let name: string;
    try {
      const actor = await jwtVerify(form.get("actor_token") ?? "", EmbeddedJWK, { typ: ACTOR_TYP, audience: tokenEndpoint, ...jwtChecks() });
      if ((await calculateJwkThumbprint(actor.protectedHeader.jwk as JWK, "sha256")) !== jkt) throw new Error("another key");
      if (typeof actor.payload.jti !== "string" || !firstUse(`actor:${jkt}:${actor.payload.jti}`)) throw new Error("replayed");
      name = String(actor.payload.sub ?? "");
    } catch {
      throw bad("invalid_request", "actor_token is not a valid, recent, unused actor token from the key that signed the DPoP proof");
    }
    if (!PROFILE_NAME.test(name)) throw bad("invalid_request", "The agent's name starts with a letter and uses up to 32 letters, digits and hyphens");

    // The delegator: a person (their own access token), or an agent (an assertion signed with its bound key).
    const subjectToken = form.get("subject_token") ?? "";
    let parent: Delegation | null = null;
    let person: Delegation["person"];
    let personToken: string;
    let want: Wanted;
    if (form.get("subject_token_type") === TYPE_JWT) {
      const refuse = (why: string) => bad("invalid_grant", `The delegation assertion ${why}`);
      if (form.has("authorization_details")) throw bad("invalid_request", "An agent's limits come from the assertion, not from the request");
      let claims: Record<string, unknown>;
      let signer: string;
      try {
        const assertion = await jwtVerify(subjectToken, EmbeddedJWK, { typ: DELEGATION_TYP, audience: tokenEndpoint, ...jwtChecks() });
        claims = assertion.payload;
        signer = await calculateJwkThumbprint(assertion.protectedHeader.jwk as JWK, "sha256");
      } catch {
        throw refuse("is not a valid, recent assertion for this endpoint");
      }
      parent = [...delegations.values()].find((d) => d.ath === claims.ath && live(d)) ?? null;
      // Only the key the delegator's token is bound to can sign for it: a stolen token is not enough.
      if (!parent || parent.jkt !== signer) throw refuse("does not come from a live delegation's key");
      if ((claims.cnf as { jkt?: string } | undefined)?.jkt !== jkt) throw refuse("was made for another key");
      if (typeof claims.jti !== "string" || !firstUse(`assertion:${signer}:${claims.jti}`)) throw refuse("was already used");
      if (parent.subAgents < 1) throw bad("invalid_grant", "This agent may not start agents");
      want = parseAccess(claims.authorization_details);
      // Narrower or equal, never wider: nothing the delegator lacks, no later than it ends, one level fewer.
      if (want.actions.some((a) => !parent!.actions.includes(a))) throw bad("invalid_authorization_details", "An agent can't give more than it has: actions");
      if (parent.boards && (want.boards ?? parent.boards).some((b) => !parent!.boards!.includes(b))) throw bad("invalid_authorization_details", "An agent can't give more than it has: boards");
      if (want.endsAt !== null && want.endsAt > parent.expiresAt) throw bad("invalid_authorization_details", "An agent can't give more than it has: access_ends_at");
      if (want.subAgents > parent.subAgents - 1) throw bad("invalid_authorization_details", "An agent can't give more than it has: sub_agents");
      want.boards ??= parent.boards;
      want.endsAt ??= parent.expiresAt;
      person = parent.person;
      personToken = rootOf(parent).personToken!;
    } else if (form.get("subject_token_type") === TYPE_ACCESS_TOKEN) {
      let details: unknown = null;
      try {
        details = JSON.parse(form.get("authorization_details") ?? "");
      } catch {
        /* reported by parseAccess */
      }
      want = parseAccess(details);
      const me = await upstreamCall<WhoAmI>(subjectToken, "whoami", {}).catch(() => null);
      // Only a person's own, unscoped credential starts a chain: never an agent's, never a narrowed one.
      if (!me || me.principal.kind !== "human" || me.principal.scope || me.principal.profile) throw bad("invalid_grant", "subject_token is a person's own access token, or an agent's delegation assertion");
      person = { id: me.principal.id, display_name: me.principal.display_name };
      personToken = subjectToken;
      want.endsAt = Math.min(want.endsAt ?? Infinity, now() + DEFAULT_SECONDS * 1000);
    } else throw bad("invalid_request", "subject_token is an access token or a delegation assertion");
    const active = [...delegations.values()].filter((d) => d.person.id === person.id && live(d)).length;
    if (active >= MAX_ACTIVE_PER_PERSON) throw bad("invalid_grant", `This person already has ${active} live delegations`);

    // Upstream this is a scoped token of the person, writing as a profile: the spec's existing way to say
    // "this agent, for this person, with less than the person has". The agent never sees it.
    const seconds = Math.max(1, Math.floor((want.endsAt! - now()) / 1000));
    const id = `dg_${randomUUID().replaceAll("-", "")}`;
    const scoped = await upstreamCall<{ token: string }>(
      personToken,
      "create_scoped_token",
      { can: want.actions, expires_in_seconds: seconds, label: `delegation ${id}`.slice(0, 60), ...(want.boards ? { boards: want.boards } : {}) },
      { "omb-profile": name },
    );
    const agent = await upstreamCall<WhoAmI>(scoped.token, "whoami", {});
    const d: Delegation = {
      id,
      person,
      agent: { id: agent.principal.id, name },
      parent,
      jkt,
      ath: "",
      actions: want.actions,
      boards: want.boards,
      subAgents: want.subAgents,
      expiresAt: now() + seconds * 1000,
      revokedAt: null,
      upstreamToken: scoped.token,
      personToken: parent ? null : personToken,
      open: new Set(),
    };
    const granted: BoardAccess[] = [{ type: DETAIL_TYPE, actions: d.actions, ...(d.boards ? { boards: d.boards } : {}), access_ends_at: new Date(d.expiresAt).toISOString(), sub_agents: d.subAgents }];
    const accessToken = await new SignJWT({ act: actorOf(d), cnf: { jkt }, authorization_details: granted })
      .setProtectedHeader({ typ: "at+jwt", alg: "ES256", kid: publicJwk.kid! })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(person.id)
      .setJti(id)
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(Math.floor(d.expiresAt / 1000))
      .sign(signing.privateKey);
    d.ath = sha256url(accessToken);
    delegations.set(id, d);
    return json({ access_token: accessToken, issued_token_type: TYPE_ACCESS_TOKEN, token_type: "DPoP", expires_in: seconds, authorization_details: granted }, 200, { "cache-control": "no-store" });
  }

  // ---- revocation: by the person, by the agent itself, or by an agent above it

  async function revocation(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const byToken = form.get("token") ? await delegationOf(form.get("token")!) : null;
    const target = byToken ?? delegations.get(form.get("delegation_id") ?? "");
    const [scheme, credential] = (req.headers.get("authorization") ?? "").split(/\s+/, 2);
    let allowed = false;
    if (scheme?.toLowerCase() === "dpop" && credential) {
      const caller = await delegationOf(credential);
      if (!caller) throw denied("invalid_token", "The token is not a live delegated token");
      await checkProof(req, `${issuer}/revoke`, credential, caller.jkt);
      allowed = !!target && descends(target, caller);
    } else if (scheme?.toLowerCase() === "bearer" && credential) {
      const me = await upstreamCall<WhoAmI>(credential, "whoami", {}).catch(() => null);
      if (!me || me.principal.kind !== "human" || me.principal.scope || me.principal.profile) throw denied("invalid_token", "Only the person, or an agent in the chain, revokes a delegation");
      allowed = !!target && target.person.id === me.principal.id;
    } else throw denied("invalid_token", "Sign in to revoke");
    // RFC 7009 §2.2: an unknown token is not an error, so a caller learns nothing about delegations that aren't theirs.
    if (allowed) revoke(target!);
    return new Response(null, { status: 200 });
  }

  // ---- the protected resource: check the token and the proof, then pass the request on

  async function proxy(req: Request): Promise<Response> {
    const [scheme, accessToken] = (req.headers.get("authorization") ?? "").split(/\s+/, 2);
    if (!accessToken) throw denied("invalid_token", "Send a delegated token");
    // RFC 9449 §7.2: a key-bound token presented as a bearer token is refused.
    if (scheme?.toLowerCase() !== "dpop") throw denied("invalid_token", "This token is bound to a key: present it with the DPoP scheme and a proof");
    const d = await delegationOf(accessToken);
    if (!d) throw denied("invalid_token", "The token is expired, revoked or not from this gateway");
    await checkProof(req, resource, accessToken, d.jkt);

    const headers = new Headers(req.headers);
    for (const name of ["authorization", "dpop", "host", "content-length", "connection", "omb-profile"]) headers.delete(name);
    headers.set("authorization", `Bearer ${d.upstreamToken}`);
    const controller = new AbortController();
    d.open.add(controller);
    req.signal.addEventListener("abort", () => (controller.abort(), d.open.delete(controller)), { once: true });
    try {
      const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: controller.signal, redirect: "manual" };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        init.duplex = "half";
      }
      const res = await fetch(`${upstream}/mcp`, init);
      const out = new Headers(res.headers);
      for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection", "www-authenticate"]) out.delete(name);
      // The body is passed through as it arrives (live streams included); the entry is dropped once it ends.
      const body = res.body?.pipeThrough(new TransformStream({ flush: () => void d.open.delete(controller) }));
      if (!body) d.open.delete(controller);
      return new Response(body ?? null, { status: res.status, headers: out });
    } catch (e) {
      d.open.delete(controller);
      if (controller.signal.aborted) throw denied("invalid_token", "The delegation was revoked");
      throw e;
    }
  }

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  return {
    list: () => [...delegations.values()].map(view),
    async fetch(req) {
      const { pathname } = new URL(req.url);
      try {
        if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
          return json({
            issuer,
            token_endpoint: tokenEndpoint,
            revocation_endpoint: `${issuer}/revoke`,
            jwks_uri: `${issuer}/jwks`,
            grant_types_supported: [GRANT_TOKEN_EXCHANGE],
            token_endpoint_auth_methods_supported: ["none"],
            dpop_signing_alg_values_supported: ["ES256"],
            authorization_details_types_supported: [DETAIL_TYPE],
          });
        }
        if (pathname === "/jwks" && req.method === "GET") return json({ keys: [publicJwk] });
        if (pathname === "/token" && req.method === "POST") return await exchange(req);
        if (pathname === "/revoke" && req.method === "POST") return await revocation(req);
        if (pathname === "/mcp") return await proxy(req);
        return json({ error: "not_found" }, 404);
      } catch (e) {
        if (!(e instanceof OAuthError)) {
          console.error("[gateway]", e instanceof Error ? e.message : e);
          return json({ error: "server_error" }, 500);
        }
        const headers: Record<string, string> = e.challenge ? { "www-authenticate": `DPoP algs="ES256", error="${e.code}", error_description="${e.message.replaceAll('"', "'")}"` } : {};
        return json({ error: e.code, error_description: e.message }, e.status, headers);
      }
    },
  };
}

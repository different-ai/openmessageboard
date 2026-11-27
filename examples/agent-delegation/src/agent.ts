/**
 * What an agent (or the launcher that starts one) needs: a key, the two kinds of proof made with it, and the
 * token exchange call. Nothing here is specific to the gateway in this folder; it is the client half of
 * proposal 0006 and uses only RFC 8693, RFC 9396 and RFC 9449 wire formats.
 */
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

export const GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
export const TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";
/** `typ` of the actor token: the new agent's statement of its name, signed with the key its token will be bound to. */
export const ACTOR_TYP = "omb-actor+jwt";
/** `typ` of a delegation assertion: an agent's signed statement that one other key may act under its delegation. */
export const DELEGATION_TYP = "omb-delegation+jwt";
/** RFC 9396 `type` of the one authorization detail this prototype understands. */
export const DETAIL_TYPE = "https://openmessageboard.com/authz/board-access";

export const PERMISSIONS = ["read", "post", "react", "label"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What a delegation may do: the RFC 9396 authorization detail, with the fields of the spec's `TokenScope`. */
export interface BoardAccess {
  type: typeof DETAIL_TYPE;
  /** `["read"]`, or all four. */
  actions: Permission[];
  /** Board IDs. Omitted: every board the delegator can reach. */
  boards?: string[];
  /** RFC 3339 instant after which the delegation is dead. Omitted: the delegator's own end, at most one hour. */
  access_ends_at?: string;
  /** How many levels of agents this agent may start. Omitted: 0, it starts none. */
  sub_agents?: number;
}
export type Access = Omit<BoardAccess, "type">;

export interface AgentKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  /** RFC 7638 SHA-256 thumbprint of the public key: what a token's `cnf.jkt` names. */
  jkt: string;
}

/** A fresh ES256 key. The private key is not extractable: it never leaves this process. */
export async function newAgentKey(): Promise<AgentKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: false });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk, "sha256") };
}

export const sha256url = (value: string): string => createHash("sha256").update(value).digest("base64url");

/** `htu` (RFC 9449 §4.2): the request URL without query and fragment. */
export function htuOf(url: string | URL): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** A DPoP proof (RFC 9449 §4.2) for one request. `accessToken` adds `ath`, which ties the proof to that token. */
export async function dpopProof(key: AgentKey, req: { method: string; url: string | URL; accessToken?: string }): Promise<string> {
  const claims: Record<string, unknown> = { htm: req.method.toUpperCase(), htu: htuOf(req.url), jti: randomUUID() };
  if (req.accessToken) claims.ath = sha256url(req.accessToken);
  return new SignJWT(claims).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk }).setIssuedAt().sign(key.privateKey);
}

/** The actor token: "I am the agent called `name`, and this is my key", for one token endpoint, for one minute. */
export async function actorToken(key: AgentKey, name: string, tokenEndpoint: string): Promise<string> {
  return new SignJWT({ sub: name, jti: randomUUID() })
    .setProtectedHeader({ typ: ACTOR_TYP, alg: "ES256", jwk: key.publicJwk })
    .setAudience(tokenEndpoint)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key.privateKey);
}

/** A `fetch` that presents `accessToken` with a fresh proof on every request. Pass it to any MCP client transport. */
export function dpopFetch(key: AgentKey, accessToken: string): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("authorization", `DPoP ${accessToken}`);
    headers.set("dpop", await dpopProof(key, { method, url, accessToken }));
    return fetch(input, { ...init, headers });
  };
}

export interface Delegated {
  access_token: string;
  issued_token_type: string;
  token_type: string;
  expires_in: number;
  authorization_details: BoardAccess[];
}

export class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description: string,
  ) {
    super(`${code}: ${description}`);
  }
}

/**
 * A delegation assertion: what an agent signs to let one other key act under its delegation, with these limits,
 * for the next minute, once. It is the subject token when an agent starts an agent. It names the delegator's own
 * token only by hash (`ath`), so that token never leaves the delegator, and it is useless to anyone but the
 * holder of the key `to` (`cnf.jkt`). RFC 9449 does not say how to prove possession of a key-bound subject
 * token; this is the one format the proposal adds.
 */
export async function delegationAssertion(delegator: AgentKey, delegatorToken: string, grant: { to: string; access: Access; tokenEndpoint: string }): Promise<string> {
  return new SignJWT({ ath: sha256url(delegatorToken), cnf: { jkt: grant.to }, authorization_details: [{ type: DETAIL_TYPE, ...grant.access }], jti: randomUUID() })
    .setProtectedHeader({ typ: DELEGATION_TYP, alg: "ES256", jwk: delegator.publicJwk })
    .setAudience(grant.tokenEndpoint)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(delegator.privateKey);
}

/**
 * RFC 8693 token exchange, made with the new agent's key. Every field has its standard meaning:
 * - the `DPoP` header is a proof by the new agent's key, so the issued token is bound to it (RFC 9449 §5);
 * - `actor_token` says who the new agent is: its name, signed by the same key;
 * - `subject_token` is whoever delegates: a person's own access token together with `access` (a person starts
 *   an agent), or a delegation assertion that carries its own limits (an agent starts an agent).
 */
export async function exchange(
  tokenEndpoint: string,
  req: { actor: AgentKey; name: string; resource?: string } & ({ personToken: string; access: Access } | { assertion: string }),
): Promise<Delegated> {
  const form = new URLSearchParams({
    grant_type: GRANT_TOKEN_EXCHANGE,
    actor_token: await actorToken(req.actor, req.name, tokenEndpoint),
    actor_token_type: TYPE_JWT,
  });
  if ("assertion" in req) {
    form.set("subject_token", req.assertion);
    form.set("subject_token_type", TYPE_JWT);
  } else {
    form.set("subject_token", req.personToken);
    form.set("subject_token_type", TYPE_ACCESS_TOKEN);
    form.set("authorization_details", JSON.stringify([{ type: DETAIL_TYPE, ...req.access }]));
  }
  if (req.resource) form.set("resource", req.resource);
  const headers = { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(req.actor, { method: "POST", url: tokenEndpoint }) };
  const res = await fetch(tokenEndpoint, { method: "POST", headers, body: form });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new ExchangeError(res.status, String(body.error), String(body.error_description ?? ""));
  return body as unknown as Delegated;
}

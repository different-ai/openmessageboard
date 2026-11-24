import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { loadConfig } from "../src/config.js";
import { createContext, type AppContext } from "../src/context.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { actorFromPrincipal, getMembership } from "../src/domain/access.js";
import { ensureHuman, ensureOwnBoard } from "../src/domain/boards.js";
import type { Actor } from "../src/domain/model.js";
import { errorResponse, type AppEnv } from "../src/http/util.js";
import { toOmbError } from "../src/errors.js";
import { isBlockedAddress, registerWorkloadRoutes, subjectMatches, verifyWorkloadToken } from "../src/auth/workload.js";

const PUBLIC_URL = "http://omb.test";

/** A tiny OpenID provider: discovery document, JWKS, and request counters. */
class FakeIssuer {
  server: Server;
  url = "";
  hits = { discovery: 0, jwks: 0 };
  private jwks: { keys: JWK[] } = { keys: [] };

  constructor() {
    this.server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        this.hits.discovery++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ issuer: this.url, jwks_uri: `${this.url}/jwks`, id_token_signing_alg_values_supported: ["RS256", "ES256"] }));
        return;
      }
      if (req.url === "/jwks") {
        this.hits.jwks++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.jwks));
        return;
      }
      res.writeHead(404).end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  publish(...keys: JWK[]): void {
    this.jwks = { keys };
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface SigningKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: CryptoKey;
  jwk: JWK;
}

async function signingKey(alg: "RS256" | "ES256", kid: string): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, alg, privateKey, jwk };
}

describe("workload identity", () => {
  const issuer = new FakeIssuer();
  let rsa: SigningKey;
  let ec: SigningKey;
  let rogue: SigningKey;
  let ctx: AppContext;
  let clock = Date.parse("2026-11-23T12:00:00.000Z");
  let owner: Actor;
  let stranger: Actor;
  let boardId: string;
  let current: Actor | null = null;
  const app = new Hono<AppEnv>();
  const dataDir = mkdtempSync(join(tmpdir(), "omb-workload-"));

  const request = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  async function token(claims: Record<string, unknown>, opts: { key?: SigningKey; iss?: string; aud?: string | string[]; iat?: number; exp?: number } = {}) {
    const key = opts.key ?? rsa;
    const now = Math.floor(clock / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
      .setIssuer(opts.iss ?? issuer.url)
      .setAudience(opts.aud ?? PUBLIC_URL)
      .setIssuedAt(opts.iat ?? now)
      .setExpirationTime(opts.exp ?? now + 300)
      .sign(key.privateKey);
  }

  async function createTrust(body: Record<string, unknown>) {
    current = owner;
    const res = await request("POST", `/api/boards/${boardId}/workload-trusts`, { issuer: issuer.url, role: "contributor", ...body });
    assert.equal(res.status, 201, await res.clone().text());
    clock += 1000;
    return ((await res.json()) as { trust: { id: string; agent_id: string; audience: string; claims: Record<string, string> } }).trust;
  }

  before(async () => {
    [rsa, ec, rogue] = await Promise.all([signingKey("RS256", "rsa-1"), signingKey("ES256", "ec-1"), signingKey("RS256", "rsa-1")]);
    await issuer.start();
    issuer.publish(rsa.jwk, ec.jwk);
    const db = openDatabase(":memory:");
    await migrate(db);
    const config = loadConfig({ ...process.env, OMB_DATA_DIR: dataDir }, { dbPath: ":memory:", testMode: true, publicUrl: PUBLIC_URL });
    ctx = createContext(config, db, () => new Date(clock));
    owner = actorFromPrincipal(ensureHuman(ctx, { email: "maya@example.test", displayName: "Maya" }), "test_token");
    stranger = actorFromPrincipal(ensureHuman(ctx, { email: "otto@unrelated.test", displayName: "Otto" }), "test_token");
    boardId = ensureOwnBoard(ctx, owner, { create: true })!.id;
    app.use("*", async (c, next) => {
      c.set("actor", current);
      await next();
    });
    app.onError((e, c) => errorResponse(c, toOmbError(e)));
    registerWorkloadRoutes(app, ctx);
  });

  after(async () => {
    await issuer.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("subject patterns are anchored, literal except for *", () => {
    assert.equal(subjectMatches("repo:acme/web:ref:refs/heads/main", "repo:acme/web:ref:refs/heads/main"), true);
    assert.equal(subjectMatches("repo:acme/web:*", "repo:acme/web:environment:production"), true);
    assert.equal(subjectMatches("repo:acme/web:*", "xrepo:acme/web:environment:production"), false);
    assert.equal(subjectMatches("repo:acme/web.app:*", "repo:acme/webXapp:ref"), false);
    assert.equal(subjectMatches("repo:acme/*:ref:refs/heads/main", "repo:acme/api:ref:refs/heads/main"), true);
    assert.equal(subjectMatches("repo:acme/*:ref:refs/heads/main", "repo:acme/api:ref:refs/heads/main-2"), false);
  });

  test("private, loopback and metadata addresses are refused outside test mode", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert.equal(isBlockedAddress(a), true, a);
    }
    for (const a of ["140.82.112.3", "2606:4700::6810:84e5"]) assert.equal(isBlockedAddress(a), false, a);
  });

  test("only the board owner manages trusts, and input is validated", async () => {
    current = stranger;
    assert.equal((await request("GET", `/api/boards/${boardId}/workload-trusts`)).status, 404);
    assert.equal((await request("POST", `/api/boards/${boardId}/workload-trusts`, { issuer: issuer.url, subject_pattern: "x", agent_name: "a", role: "reader" })).status, 404);
    current = null;
    assert.equal((await request("GET", `/api/boards/${boardId}/workload-trusts`)).status, 401);

    current = owner;
    const bad = async (body: Record<string, unknown>) => {
      const res = await request("POST", `/api/boards/${boardId}/workload-trusts`, { issuer: issuer.url, subject_pattern: "repo:acme/web:*", agent_name: "bot", role: "reader", ...body });
      assert.equal(res.status, 400, JSON.stringify(body));
      return ((await res.json()) as { error: { code: string } }).error.code;
    };
    assert.equal(await bad({ subject_pattern: "*" }), "invalid_argument");
    assert.equal(await bad({ subject_pattern: "**" }), "invalid_argument");
    assert.equal(await bad({ subject_pattern: "   " }), "invalid_argument");
    assert.equal(await bad({ issuer: "ftp://issuer.example.test" }), "invalid_argument");
    assert.equal(await bad({ issuer: "https://issuer.example.test/?x=1" }), "invalid_argument");
    assert.equal(await bad({ issuer: PUBLIC_URL }), "invalid_argument");
    assert.equal(await bad({ claims: { environment: 1 } }), "invalid_argument");
    assert.equal(await bad({ claims: { sub: "x" } }), "invalid_argument");
    assert.equal(await bad({ role: "owner" }), "invalid_argument");
  });

  test("a matching token acts as the trust's agent; anything else is not a workload token", async () => {
    const trust = await createTrust({ subject_pattern: "repo:acme/web:ref:refs/heads/main", claims: { repository_owner: "acme" }, agent_name: "web-deploy" });
    assert.equal(trust.audience, PUBLIC_URL);
    assert.deepEqual(trust.claims, { repository_owner: "acme" });
    assert.equal(getMembership(ctx, boardId, trust.agent_id)?.role, "contributor");

    current = owner;
    const listed = (await (await request("GET", `/api/boards/${boardId}/workload-trusts`)).json()) as { trusts: { id: string; agent_name: string }[] };
    assert.deepEqual(listed.trusts.map((t) => [t.id, t.agent_name]), [[trust.id, "web-deploy"]]);

    const claims = { sub: "repo:acme/web:ref:refs/heads/main", repository_owner: "acme" };
    const actor = await verifyWorkloadToken(ctx, await token(claims));
    assert.ok(actor);
    assert.equal(actor.id, trust.agent_id);
    assert.equal(actor.kind, "agent");
    assert.equal(actor.via, "workload");
    assert.equal(actor.ownerId, owner.id);
    assert.equal(actor.displayName, "web-deploy");
    const used = ctx.db.prepare("SELECT last_used_at FROM workload_trusts WHERE id = ?").get(trust.id) as { last_used_at: string | null };
    assert.equal(used.last_used_at, new Date(clock).toISOString());

    // Either key family works.
    assert.equal((await verifyWorkloadToken(ctx, await token(claims, { key: ec })))?.id, trust.agent_id);

    const now = Math.floor(clock / 1000);
    const rejected: [string, Promise<string>][] = [
      ["wrong audience", token(claims, { aud: "https://other.example.test" })],
      ["wrong subject", token({ ...claims, sub: "repo:acme/web:ref:refs/heads/dev" })],
      ["wrong claim", token({ ...claims, repository_owner: "acme-evil" })],
      ["missing claim", token({ sub: claims.sub })],
      ["expired", token(claims, { iat: now - 600, exp: now - 120 })],
      ["issued over an hour ago", token(claims, { iat: now - 3 * 3600, exp: now + 300 })],
      ["issued in the future", token(claims, { iat: now + 600, exp: now + 900 })],
      ["unpublished key with a known kid", token(claims, { key: rogue })],
      ["unknown issuer", token(claims, { iss: "https://unknown-issuer.example.test" })],
    ];
    for (const [name, t] of rejected) assert.equal(await verifyWorkloadToken(ctx, await t), null, name);

    // Not JWTs at all, or not an allowed algorithm.
    assert.equal(await verifyWorkloadToken(ctx, "omb_at_abc"), null);
    assert.equal(await verifyWorkloadToken(ctx, "a.b.c"), null);
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer.url)
      .setAudience(PUBLIC_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode("a-shared-secret-that-should-never-be-accepted"));
    assert.equal(await verifyWorkloadToken(ctx, hs), null, "HS256");

    // Discovery is cached per issuer.
    assert.equal(issuer.hits.discovery, 1);
  });

  test("wildcard subjects match, and the oldest matching trust wins", async () => {
    const api = await createTrust({ subject_pattern: "repo:acme/api:*", agent_name: "api-deploy", role: "reader" });
    const anyRepo = await createTrust({ subject_pattern: "repo:acme/*", agent_name: "acme-any" });

    const apiActor = await verifyWorkloadToken(ctx, await token({ sub: "repo:acme/api:environment:production" }));
    assert.equal(apiActor?.id, api.agent_id);
    const docsActor = await verifyWorkloadToken(ctx, await token({ sub: "repo:acme/docs:ref:refs/heads/main" }));
    assert.equal(docsActor?.id, anyRepo.agent_id);
    assert.equal(await verifyWorkloadToken(ctx, await token({ sub: "repo:acme-evil/api:ref:refs/heads/main" })), null);
  });

  test("a custom audience is honoured", async () => {
    const vercel = await createTrust({ subject_pattern: "owner:acme:project:web:environment:production", audience: "https://vercel.com/acme", agent_name: "vercel-prod" });
    const claims = { sub: "owner:acme:project:web:environment:production" };
    assert.equal((await verifyWorkloadToken(ctx, await token(claims, { aud: ["https://vercel.com/acme", "other"] })))?.id, vercel.agent_id);
    assert.equal(await verifyWorkloadToken(ctx, await token(claims)), null);
  });

  test("deleting a trust ends access and removes the agent from the board", async () => {
    const trust = await createTrust({ subject_pattern: "project_path:acme/infra:ref_type:branch:ref:main", agent_name: "infra-deploy" });
    const claims = { sub: "project_path:acme/infra:ref_type:branch:ref:main" };
    assert.equal((await verifyWorkloadToken(ctx, await token(claims)))?.id, trust.agent_id);

    current = stranger;
    assert.equal((await request("DELETE", `/api/workload-trusts/${trust.id}`)).status, 404);
    current = owner;
    const res = await request("DELETE", `/api/workload-trusts/${trust.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true });
    assert.equal(getMembership(ctx, boardId, trust.agent_id), undefined);
    assert.equal(await verifyWorkloadToken(ctx, await token(claims)), null);
    assert.equal((await request("DELETE", `/api/workload-trusts/${trust.id}`)).status, 404);
  });

  test("a disabled owner's workloads can't sign in", async () => {
    const claims = { sub: "repo:acme/web:ref:refs/heads/main", repository_owner: "acme" };
    assert.ok(await verifyWorkloadToken(ctx, await token(claims)));
    ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?").run(new Date(clock).toISOString(), owner.id);
    try {
      assert.equal(await verifyWorkloadToken(ctx, await token(claims)), null);
    } finally {
      ctx.db.prepare("UPDATE principals SET disabled_at = NULL WHERE id = ?").run(owner.id);
    }
  });
});

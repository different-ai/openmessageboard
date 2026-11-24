import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { SPEC_VERSION, type Profile, type ServerInfo } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, toOmbError } from "../errors.js";
import type { Auth } from "../auth/auth.js";
import { OAUTH_SCOPES } from "../auth/auth.js";
import type { Resolver } from "../auth/resolve.js";
import { apiScopeNeed, requireScope } from "../auth/scopes.js";
import type { EventSubscriptions } from "../mcp/events.js";
import { createMcpServer } from "../mcp/server.js";
import { isListenRequest, serveListen } from "../mcp/listen.js";
import { registerApiRoutes } from "./api.js";
import { registerChannelRoutes } from "./channels.js";
import { registerOAuthConsentRoutes } from "./consent.js";
import { clientMetadataDocument } from "../auth/openwork.js";
import type { AppEnv, RouteModule } from "./util.js";

export interface AppOptions {
  auth: Auth;
  resolver: Resolver;
  events: EventSubscriptions;
  modules?: { name: Profile; register: RouteModule }[];
  openworkAvailable?: boolean;
}

export function createApp(ctx: AppContext, opts: AppOptions) {
  const app = new Hono<AppEnv>();
  const base = ctx.config.publicUrl;
  const origin = new URL(base).origin;
  const profiles: Profile[] = [
    "core",
    "live",
    "events",
    "tasks",
    "automation",
    ...(ctx.config.allowImport ? (["import"] as Profile[]) : []),
    ...(opts.modules ?? []).map((m) => m.name),
  ];
  const serverInfo = (): ServerInfo => ({
    spec_version: SPEC_VERSION,
    implementation: { name: "openmessageboard-reference", version: ctx.config.version },
    profiles,
    mcp_endpoint: `${base}/mcp`,
    issuer: `${base}/api/auth`,
    web_url: base,
    limits: { ...ctx.config.plans.base },
    rate_limits: { ...ctx.config.rateLimits },
    plans: [
      { id: "base", name: "Base", description: "Accounts that sign in by email", limits: { ...ctx.config.plans.base } },
      { id: "openwork", name: "OpenWork", description: "Accounts that sign in with OpenWork Cloud", limits: { ...ctx.config.plans.openwork } },
    ],
    auth: {
      providers: [...ctx.config.authProviders],
      openwork: ctx.config.authProviders.includes("openwork")
        ? { issuer: ctx.config.openwork.issuer, available: opts.openworkAvailable === true, sign_up_url: ctx.config.openwork.signUpUrl }
        : null,
    },
  });

  app.onError((err, c) => {
    const e = err instanceof OmbError ? err : toOmbError(err);
    if (e.code === "internal") console.error(err);
    return c.json({ error: e.toBody() }, e.status as 400);
  });

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    await next();
  });

  // CORS: bearer-only surfaces can be called from any origin; cookie-authenticated /api stays same-origin.
  const corsPaths = ["/mcp", "/.well-known/"];
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (!corsPaths.some((p) => path === p || path.startsWith(p))) return next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id, omb-profile");
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Expose-Headers", "www-authenticate, mcp-protocol-version");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  });

  // Authentication: bearer token (agents, CLI, MCP clients, deployments) or session cookie (browser).
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/auth/") || path.startsWith("/hooks/") || path === "/healthz") {
      c.set("actor", null);
      return next();
    }
    const { actor, source, invalidBearer, error } = await opts.resolver.fromRequest(c.req.raw);
    if (invalidBearer && (path.startsWith("/api/") || path === "/mcp")) {
      c.header("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
      return c.json({ error: { code: "unauthenticated", message: "The bearer token is invalid or expired" } }, 401);
    }
    // A valid credential with an OMB-Profile header it can't use (an agent's, or another profile than the token's).
    if (error) return c.json({ error: error.toBody() }, error.status as 400);
    // Scoped tokens reach only the conversation routes they are allowed (fail closed for everything else).
    if (actor?.scope && path.startsWith("/api/")) {
      try {
        requireScope(actor, apiScopeNeed(c.req.method, path));
      } catch (e) {
        const err = toOmbError(e);
        return c.json({ error: err.toBody() }, err.status as 403);
      }
    }
    // CSRF: cookie-authenticated writes must come from our own origin.
    if (source === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const reqOrigin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if ((reqOrigin && reqOrigin !== origin) || (!reqOrigin && site && site !== "same-origin")) {
        return c.json({ error: { code: "forbidden", message: "Cross-site request refused" } }, 403);
      }
    }
    c.set("actor", actor);
    return next();
  });

  app.get("/healthz", (c) => {
    ctx.db.prepare("SELECT 1").get();
    return c.json({ ok: true, version: ctx.config.version });
  });
  app.get("/metrics", (c) => {
    const token = ctx.config.metricsToken;
    const allowed = ctx.config.testMode || (token !== null && c.req.header("x-omb-metrics-token") === token);
    if (!allowed) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    const mem = process.memoryUsage();
    return c.json({ live_connections: ctx.connections.size, hub_listeners: ctx.hub.size, rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed, uptime_s: Math.round(process.uptime()) });
  });

  // Discovery
  app.get("/oauth/openwork-client.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(clientMetadataDocument(ctx));
  });
  app.get("/.well-known/openmessageboard", (c) => c.json(serverInfo()));
  const protectedResource = (c: { json: (b: unknown) => Response }) =>
    c.json({
      resource: `${base}/mcp`,
      authorization_servers: [`${base}/api/auth`],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "OpenMessageBoard",
      resource_documentation: `${base}/`,
    });
  app.get("/.well-known/oauth-protected-resource", (c) => protectedResource(c));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => protectedResource(c));
  const asMeta = oauthProviderAuthServerMetadata(opts.auth);
  const oidcMeta = oauthProviderOpenIdConfigMetadata(opts.auth);
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth", "/api/auth/.well-known/oauth-authorization-server"]) {
    app.get(p, (c) => asMeta(c.req.raw));
  }
  for (const p of ["/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth", "/api/auth/.well-known/openid-configuration"]) {
    app.get(p, (c) => oidcMeta(c.req.raw));
  }

  // Better Auth (email sign-in, OAuth authorization server)
  app.on(["GET", "POST"], "/api/auth/*", (c) => opts.auth.handler(c.req.raw));

  registerOAuthConsentRoutes(app, ctx, opts.auth);
  registerApiRoutes(app, ctx, serverInfo);
  registerChannelRoutes(app, ctx);
  for (const m of opts.modules ?? []) m.register(app, ctx);

  // MCP (Streamable HTTP). subscriptions/listen is served here with per-principal authorization.
  const mcp = createMcpHandler(({ era }) => createMcpServer({ ctx, serverInfo, events: opts.events }, era), {
    onerror: (e) => {
      if (!/Rejected inbound request|refused/i.test(e.message)) console.error("mcp:", e.message);
    },
    maxSubscriptions: 100_000,
  });
  app.all("/mcp", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="boards offline_access"`);
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Authentication required" } }, 401);
    }
    if (c.req.method === "POST") {
      const body = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      if (isListenRequest(body)) return serveListen(ctx, actor, body, c.req.raw.signal);
    }
    return mcp.fetch(c.req.raw, { authInfo: { token: "redacted", clientId: actor.clientId ?? actor.via, scopes: ["boards"], extra: { actor } } });
  });

  // Browser client (single-page app) with a strict content security policy.
  const dist = ctx.config.webDist;
  if (dist && existsSync(join(dist, "index.html"))) {
    const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api/") || p === "/mcp" || p.startsWith("/.well-known/") || p.startsWith("/hooks/")) return next();
      if (/\.[a-z0-9]+$/i.test(p) && existsSync(join(dist, p))) return serveStatic({ root: dist })(c, next);
      c.header("Content-Security-Policy", csp);
      c.header("X-Frame-Options", "DENY");
      return c.html(indexHtml);
    });
  } else {
    app.get("/", (c) => c.text("OpenMessageBoard server is running. Build the web client (pnpm --filter @openmessageboard/web build) to serve the browser UI here."));
  }
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return { app, serverInfo };
}

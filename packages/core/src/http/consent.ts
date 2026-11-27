import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { OAuthConsentBody } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import type { Auth } from "../auth/auth.js";
import { createAgent, listAgents, requireOwnAgent } from "../domain/boards.js";
import { getPrincipal, requireHuman } from "../domain/access.js";
import { ensureProfile } from "../domain/profiles.js";
import { parseBody, requireActor, type AppHono } from "./util.js";

/**
 * Consent for MCP clients. The person chooses which principal the client acts as: themselves, one of their agents,
 * a new agent, or one of their profiles (their own access, shown as "<profile> via <person>"). The choice is recorded against the browser session and read by the authorization server's
 * `consentReferenceId` hook, so the issued token carries that principal.
 */
export function registerOAuthConsentRoutes(app: AppHono, ctx: AppContext, auth: Auth): void {
  async function checkQuery(query: string): Promise<URLSearchParams> {
    if (!query || !(await verifyOAuthQueryParams(query, ctx.config.secret).catch(() => false))) {
      throw invalid("This authorization request is invalid or has expired. Start connecting again from your app.");
    }
    return new URLSearchParams(query);
  }

  app.get("/api/oauth/consent", async (c) => {
    const actor = requireActor(c);
    requireHuman(actor);
    const raw = new URL(c.req.url).search.replace(/^\?/, "");
    const params = await checkQuery(raw);
    const clientId = params.get("client_id") ?? "";
    const client = ctx.db.prepare(`SELECT "name", "uri" FROM "oauthClient" WHERE "clientId" = ?`).get(clientId) as { name: string | null; uri: string | null } | undefined;
    return c.json({
      client_name: client?.name || clientId || "An MCP client",
      client_uri: client?.uri ?? null,
      scopes: (params.get("scope") ?? "").split(" ").filter(Boolean),
      agents: listAgents(ctx, actor)
        .filter((a) => !a.disabled_at)
        .map((a) => ({ id: a.id, display_name: a.display_name })),
      profiles: (
        ctx.db.prepare("SELECT profile_name FROM principals WHERE owner_id = ? AND profile_name IS NOT NULL AND disabled_at IS NULL ORDER BY created_at").all(actor.id) as {
          profile_name: string;
        }[]
      ).map((r) => r.profile_name),
    });
  });

  app.post("/api/oauth/consent", async (c) => {
    const actor = requireActor(c);
    requireHuman(actor);
    const body = await parseBody(c, OAuthConsentBody);
    const params = await checkQuery(body.oauth_query);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new OmbError("unauthenticated", "Sign in to continue");
    let principalId = actor.id;
    if (body.accept) {
      if (typeof body.act_as === "object" && "agent_id" in body.act_as) principalId = requireOwnAgent(ctx, actor, body.act_as.agent_id).id;
      else if (typeof body.act_as === "object" && "new_agent_name" in body.act_as) principalId = createAgent(ctx, actor, body.act_as.new_agent_name).id;
      else if (typeof body.act_as === "object" && "profile" in body.act_as) principalId = ensureProfile(ctx, getPrincipal(ctx, actor.id)!, body.act_as.profile).id;
    }
    const sessionId = String(session.session.id);
    ctx.db
      .prepare("INSERT INTO oauth_consent_choice (session_id, principal_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET principal_id = excluded.principal_id, expires_at = excluded.expires_at")
      .run(sessionId, principalId, new Date(ctx.now().getTime() + 600_000).toISOString());
    try {
      const headers = new Headers({ "content-type": "application/json", origin: new URL(ctx.config.publicUrl).origin });
      const cookie = c.req.header("cookie");
      if (cookie) headers.set("cookie", cookie);
      const res = await auth.handler(
        new Request(`${ctx.config.publicUrl}/api/auth/oauth2/consent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accept: body.accept, oauth_query: body.oauth_query, ...(params.get("scope") ? { scope: params.get("scope") } : {}) }),
        }),
      );
      const payload = (await res.json().catch(() => ({}))) as { url?: string; redirect_uri?: string; message?: string; error_description?: string };
      const redirect = payload.url ?? payload.redirect_uri;
      if (!res.ok || !redirect) throw invalid(payload.error_description ?? payload.message ?? "The authorization server refused this request");
      return c.json({ redirect_url: redirect });
    } finally {
      ctx.db.prepare("DELETE FROM oauth_consent_choice WHERE session_id = ?").run(sessionId);
    }
  });
}

import { PROFILE_HEADER } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, toOmbError } from "../errors.js";
import { actorFromPrincipal, getPrincipal } from "../domain/access.js";
import { ensureHuman, principalForToken } from "../domain/boards.js";
import { applyProfileHeader, ensureProfile, profileActor } from "../domain/profiles.js";
import type { Actor } from "../domain/model.js";
import { sha256 } from "../ids.js";
import { OPAQUE_ACCESS_PREFIX, type Auth } from "./auth.js";
import { refreshPlan } from "../domain/plans.js";

export type WorkloadVerifier = (ctx: AppContext, token: string) => Promise<Actor | null>;

export interface Resolver {
  /** `error` is set when the credential is valid but the request can't be served as asked (a bad `OMB-Profile`). */
  fromRequest(req: Request): Promise<{ actor: Actor | null; source: "cookie" | "bearer" | "none"; invalidBearer: boolean; error?: OmbError }>;
  fromBearer(token: string): Promise<Actor | null>;
}

function toMillis(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/** Looks up an OAuth access token issued by our authorization server (stored hashed by Better Auth). */
function actorForOAuthToken(ctx: AppContext, raw: string): Actor | null {
  const row = ctx.db
    .prepare(`SELECT "userId" AS user_id, "referenceId" AS reference_id, "clientId" AS client_id, "expiresAt" AS expires_at, "revoked" AS revoked FROM "oauthAccessToken" WHERE "token" = ?`)
    .get(sha256(raw.slice(OPAQUE_ACCESS_PREFIX.length))) as
    | { user_id: string | null; reference_id: string | null; client_id: string | null; expires_at: unknown; revoked: unknown }
    | undefined;
  if (!row || !row.user_id) return null;
  if (row.revoked) return null;
  const exp = toMillis(row.expires_at);
  if (exp === null || exp <= ctx.now().getTime()) return null;
  const user = ctx.db.prepare(`SELECT "email", "name", "emailVerified" AS verified FROM "user" WHERE "id" = ?`).get(row.user_id) as
    | { email: string; name: string | null; verified: unknown }
    | undefined;
  if (!user || !user.verified) return null;
  const human = ensureHuman(ctx, { email: user.email, displayName: user.name ?? undefined, authUserId: row.user_id });
  if (human.disabled_at) return null;
  refreshPlan(ctx, human.id, row.user_id);
  if (row.reference_id && row.reference_id !== human.id) {
    const agent = getPrincipal(ctx, row.reference_id);
    if (!agent || agent.kind !== "agent" || agent.owner_id !== human.id || agent.disabled_at) return null;
    return actorFromPrincipal(agent, "oauth", row.client_id ?? undefined);
  }
  return actorFromPrincipal(human, "oauth", row.client_id ?? undefined);
}

export function createResolver(ctx: AppContext, auth: Auth, workload: WorkloadVerifier | null): Resolver {
  async function fromBearer(token: string): Promise<Actor | null> {
    if (token.startsWith(OPAQUE_ACCESS_PREFIX)) return actorForOAuthToken(ctx, token);
    if (token.startsWith("omb_")) {
      const found = principalForToken(ctx, token);
      if (!found) return null;
      const via = found.kind === "agent" ? "agent_token" : found.kind === "personal" ? "personal_token" : "test_token";
      const actor: Actor = { ...actorFromPrincipal(found.principal, via), scope: found.scope };
      // A token scoped to a profile always writes as it.
      if (found.scope?.profile && found.principal.kind === "human") return profileActor(actor, ensureProfile(ctx, found.principal, found.scope.profile));
      return actor;
    }
    if (workload && token.split(".").length === 3) {
      try {
        return await workload(ctx, token);
      } catch {
        return null;
      }
    }
    return null;
  }

  async function credential(req: Request): Promise<{ actor: Actor | null; source: "cookie" | "bearer" | "none"; invalidBearer: boolean }> {
    const header = req.headers.get("authorization");
    if (header) {
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      const actor = m ? await fromBearer(m[1]!.trim()) : null;
      return { actor, source: "bearer", invalidBearer: !actor };
    }
    const vercel = req.headers.get("x-vercel-oidc-token");
    if (vercel && workload) {
      const actor = await fromBearer(vercel);
      if (actor) return { actor, source: "bearer", invalidBearer: false };
    }
    if (!req.headers.get("cookie")) return { actor: null, source: "none", invalidBearer: false };
    const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
    if (!session?.user?.email || !session.user.emailVerified) return { actor: null, source: "none", invalidBearer: false };
    const human = ensureHuman(ctx, { email: session.user.email, displayName: session.user.name || undefined, authUserId: session.user.id });
    if (human.disabled_at) return { actor: null, source: "none", invalidBearer: false };
    refreshPlan(ctx, human.id, session.user.id);
    return { actor: actorFromPrincipal(human, "session"), source: "cookie", invalidBearer: false };
  }

  return {
    fromBearer,
    async fromRequest(req) {
      const found = await credential(req);
      const profile = req.headers.get(PROFILE_HEADER);
      if (!found.actor || !profile) return found;
      try {
        return { ...found, actor: applyProfileHeader(ctx, found.actor, profile) };
      } catch (e) {
        return { ...found, actor: null, error: toOmbError(e) };
      }
    },
  };
}

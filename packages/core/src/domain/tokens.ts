import { SCOPED_TOKEN_MAX_SECONDS, type CreatedToken, type TokenPermission, type TokenScope } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { forbidden, invalid, notFound } from "../errors.js";
import { normalizeCan, requireScope } from "../auth/scopes.js";
import { activeMembership, getPrincipal, nowIso, requireHuman } from "./access.js";
import { mintToken, requireOwnAgent, type StoredScope } from "./boards.js";
import type { Actor } from "./model.js";
import { ensureProfile, normalizeProfileName, sameProfile } from "./profiles.js";

/** At most this many live personal tokens per person, so scoped tokens minted from MCP can't pile up. */
export const MAX_ACTIVE_PERSONAL_TOKENS = 100;
const DEFAULT_SCOPED_SECONDS = 3600;

export interface ScopeInput {
  boards?: string[] | undefined;
  can?: TokenPermission[] | undefined;
  profile?: string | undefined;
  expires_in_seconds?: number | undefined;
}

/**
 * Validates a requested scope. `creator` is the person (or their profile) minting the token; every board must be
 * one they can reach now. Returns no scope when nothing limits the token (it may still expire).
 */
function buildScope(
  ctx: AppContext,
  creator: Actor,
  personId: string,
  input: ScopeInput,
  opts: { allowProfile: boolean; forceScope: boolean },
): { scope: StoredScope | null; expiresAt: string | null } {
  let boards: string[] | null = null;
  if (input.boards) {
    boards = [...new Set(input.boards)];
    for (const b of boards) if (!activeMembership(ctx, b, creator)) throw notFound("Board");
  }
  let profile: string | null = null;
  if (input.profile !== undefined) {
    if (!opts.allowProfile) throw invalid("Agent tokens can't name a profile; an agent can't write as a profile");
    const person = getPrincipal(ctx, personId)!;
    profile = ensureProfile(ctx, person, normalizeProfileName(input.profile)).profile_name!;
  }
  const limited = opts.forceScope || input.boards !== undefined || input.can !== undefined || input.profile !== undefined;
  const scope: StoredScope | null = limited ? { boards, can: normalizeCan(input.can), profile } : null;
  const expiresAt = input.expires_in_seconds ? new Date(ctx.now().getTime() + input.expires_in_seconds * 1000).toISOString() : null;
  return { scope, expiresAt };
}

function assertTokenRoom(ctx: AppContext, personId: string): void {
  const n = (
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE principal_id = ? AND kind = 'personal' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .get(personId, nowIso(ctx)) as { n: number }
  ).n;
  if (n >= MAX_ACTIVE_PERSONAL_TOKENS) throw forbidden(`You have ${n} active tokens, the most this server allows; revoke some first`);
}

/** `POST /api/tokens`: a personal token, optionally scoped. */
export function createPersonalToken(ctx: AppContext, actor: Actor, input: ScopeInput & { label?: string | undefined }): CreatedToken {
  requireScope(actor, "manage");
  requireHuman(actor, "Agents use agent tokens");
  assertTokenRoom(ctx, actor.id);
  const { scope, expiresAt } = buildScope(ctx, actor, actor.id, input, { allowProfile: true, forceScope: false });
  return mintToken(ctx, actor.id, "personal", input.label, { scope, expiresAt });
}

/** `POST /api/agents/:id/tokens`: an agent token, optionally limited to boards or to reading, or expiring. */
export function createAgentToken(ctx: AppContext, actor: Actor, agentId: string, input: ScopeInput & { label?: string | undefined }): CreatedToken {
  requireScope(actor, "manage");
  requireHuman(actor);
  const agent = requireOwnAgent(ctx, actor, agentId);
  if (agent.disabled_at) throw invalid("This agent is disabled");
  const { scope, expiresAt } = buildScope(ctx, actor, actor.id, input, { allowProfile: false, forceScope: false });
  return mintToken(ctx, agent.id, "agent", input.label, { scope, expiresAt });
}

/**
 * `create_scoped_token`: a short-lived, narrowed personal token to hand to a sandboxed agent. Called as a person,
 * or as one of their profiles (the token then writes as that profile and can't name another).
 */
export function createScopedToken(
  ctx: AppContext,
  actor: Actor,
  input: ScopeInput & { label?: string | undefined },
): { id: string; token: string; prefix: string; scope: TokenScope } {
  requireScope(actor, "manage");
  if (actor.kind !== "human" && !actor.profile) throw forbidden("Only people can create tokens; agents act through the person they belong to");
  const personId = actor.profile ? actor.ownerId! : actor.id;
  if (actor.profile && input.profile !== undefined && !sameProfile(input.profile, actor.profile)) {
    throw forbidden(`Writing as "${actor.profile}", you can only create tokens for that profile`);
  }
  const seconds = input.expires_in_seconds ?? DEFAULT_SCOPED_SECONDS;
  if (seconds > SCOPED_TOKEN_MAX_SECONDS) throw invalid(`expires_in_seconds can be at most ${SCOPED_TOKEN_MAX_SECONDS}`);
  assertTokenRoom(ctx, personId);
  const profile = input.profile ?? actor.profile ?? undefined;
  const { scope, expiresAt } = buildScope(ctx, actor, personId, { ...input, profile, expires_in_seconds: seconds }, { allowProfile: true, forceScope: true });
  const created = mintToken(ctx, personId, "personal", input.label?.trim() || "Scoped token", { scope, expiresAt });
  return { id: created.id, token: created.token, prefix: created.prefix, scope: created.scope! };
}

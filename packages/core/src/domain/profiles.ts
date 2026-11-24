import { PROFILE_NAME_PATTERN, type BoardActor, type Role } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, forbidden, invalid } from "../errors.js";
import { newId } from "../ids.js";
import { getPrincipal, isExpired, nowIso, requireMember } from "./access.js";
import type { Actor, MembershipRow, PrincipalRow } from "./model.js";

/**
 * Profiles: named identities a person writes as ("fx via ada"). A profile is an agent principal owned by the
 * person, flagged with `profile_name`. It has no membership of its own: on every board it acts with its person's
 * membership and role, so it needs no invite and no token. Its handle is `<person-handle>/<profile>`.
 */
export const MAX_PROFILES_PER_PERSON = 200;

export function normalizeProfileName(raw: string): string {
  const name = raw.trim();
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw invalid(`Profile names start with a letter and use up to 32 letters, digits and hyphens (got "${name.slice(0, 40)}")`);
  }
  return name;
}

export function sameProfile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findProfile(ctx: AppContext, personId: string, name: string): PrincipalRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM principals WHERE owner_id = ? AND profile_name IS NOT NULL AND lower(profile_name) = lower(?)")
    .get(personId, name) as PrincipalRow | undefined;
}

/** Finds or creates the person's profile. The first request that names it creates it; nothing else is set up. */
export function ensureProfile(ctx: AppContext, person: PrincipalRow, raw: string): PrincipalRow {
  if (person.kind !== "human") throw forbidden("Only people have profiles; an agent can't write as a profile");
  const name = normalizeProfileName(raw);
  const existing = findProfile(ctx, person.id, name);
  if (existing) return existing;
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM principals WHERE owner_id = ? AND profile_name IS NOT NULL").get(person.id) as { n: number }).n;
  if (count >= MAX_PROFILES_PER_PERSON) throw forbidden(`You have ${count} profiles, the most this server allows`);
  ctx.db
    .prepare("INSERT INTO principals (id, kind, display_name, email, owner_id, created_at, profile_name) VALUES (?, 'agent', ?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(newId("p"), name, person.id, nowIso(ctx), name);
  return findProfile(ctx, person.id, name)!;
}

/** The actor for a person writing as one of their profiles. Keeps how the person authenticated and any token scope. */
export function profileActor(person: Actor, row: PrincipalRow): Actor {
  return {
    id: row.id,
    kind: "agent",
    displayName: row.display_name,
    ownerId: person.id,
    email: null,
    via: person.via,
    profile: row.profile_name ?? row.display_name,
    scope: person.scope ?? null,
    ...(person.clientId ? { clientId: person.clientId } : {}),
  };
}

/**
 * Applies the `OMB-Profile` header to an authenticated caller.
 * - A person (session, personal token, OAuth, test token) writes as that profile.
 * - A credential bound to a profile (a scoped token with `profile`, an OAuth grant for a profile) can't change it.
 * - Any other agent is refused: an agent can't write as a profile.
 */
export function applyProfileHeader(ctx: AppContext, actor: Actor, header: string | null | undefined): Actor {
  const raw = header?.trim();
  if (!raw) return actor;
  const name = normalizeProfileName(raw);
  if (actor.profile) {
    if (sameProfile(actor.profile, name)) return actor;
    throw forbidden(`This credential always writes as the profile "${actor.profile}"`);
  }
  if (actor.kind !== "human") throw forbidden("An agent can't write as a profile; profiles belong to people");
  const person = getPrincipal(ctx, actor.id);
  if (!person) throw new OmbError("unauthenticated", "Unknown principal");
  return profileActor(actor, ensureProfile(ctx, person, name));
}

export function profileIdsOf(ctx: AppContext, personId: string): string[] {
  return (ctx.db.prepare("SELECT id FROM principals WHERE owner_id = ? AND profile_name IS NOT NULL").all(personId) as { id: string }[]).map((r) => r.id);
}

/** A principal plus, for a person, their profiles: what a person's handle covers in filters. */
export function coveredPrincipalIds(ctx: AppContext, principalId: string): string[] {
  const p = getPrincipal(ctx, principalId);
  return p?.kind === "human" ? [principalId, ...profileIdsOf(ctx, principalId)] : [principalId];
}

/**
 * Who may change (delete, later edit) a message: its author; a person for what their agents and profiles wrote;
 * the board owner for anything. A profile changes only what it wrote, whatever its person's role.
 */
export function canChangeMessage(actor: Actor, author: { id: string; owner_id: string | null }, role: Role): boolean {
  if (author.id === actor.id) return true;
  if (actor.profile) return false;
  if (author.owner_id === actor.id) return true;
  return role === "owner";
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "member"
  );
}

type ActorRow = PrincipalRow & { owner_name: string | null };

/** People, agents, profiles and synced authors who belong to or have written on a board. */
export function listActors(ctx: AppContext, actor: Actor, boardId: string): BoardActor[] {
  requireMember(ctx, actor, boardId);
  const memberships = ctx.db.prepare("SELECT * FROM memberships WHERE board_id = ? ORDER BY joined_at").all(boardId) as MembershipRow[];
  const active = new Map(memberships.filter((m) => !isExpired(ctx, m)).map((m) => [m.principal_id, m]));
  const authors = (
    ctx.db.prepare("SELECT author_id, MIN(created_at) AS first FROM messages WHERE board_id = ? GROUP BY author_id ORDER BY first").all(boardId) as { author_id: string }[]
  ).map((r) => r.author_id);
  const ids = [...new Set([...active.keys(), ...authors])];
  if (ids.length === 0) return [];
  const rows = new Map<string, ActorRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of ctx.db
      .prepare(`SELECT p.*, o.display_name AS owner_name FROM principals p LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as ActorRow[]) {
      rows.set(r.id, r);
    }
  }
  const handleOf = (id: string, fallback: string) => active.get(id)?.handle ?? slug(fallback);
  const out: BoardActor[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) continue;
    const isProfile = r.kind === "agent" && !!r.profile_name;
    const via = r.owner_id && r.owner_name ? { id: r.owner_id, display_name: r.owner_name } : null;
    if (isProfile) {
      const person = r.owner_id ? active.get(r.owner_id) : undefined;
      out.push({
        id: r.id,
        kind: "profile",
        handle: `${person?.handle ?? slug(r.owner_name ?? "member")}/${r.profile_name!.toLowerCase()}`,
        display_name: r.display_name,
        via,
        is_member: !!person,
      });
      continue;
    }
    out.push({ id: r.id, kind: r.kind, handle: handleOf(r.id, r.display_name), display_name: r.display_name, via: r.kind === "agent" ? via : null, is_member: active.has(r.id) });
  }
  return out;
}

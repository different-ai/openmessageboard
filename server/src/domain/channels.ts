import {
  CHANNEL_PATH_PATTERN,
  DEFAULT_CHANNEL,
  GRANT_PATTERN_PATTERN,
  MAX_CHANNEL_CHARS,
  MAX_GRANTS_PER_BOARD,
  MAX_GRANT_PATTERNS,
  MAX_GRANT_PRINCIPALS,
  PERMISSIONS,
  type AccessExplanation,
  type Channel,
  type Grant,
  type GrantCanInput,
  type GrantPrincipal,
  type Permission,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type { HubEvent } from "../live/hub.js";
import { activeMembership, getPrincipal, nowIso, requireMember } from "./access.js";
import { recordEvent } from "./boards.js";
import { ChannelAccess, ROLE_CAP, decide, maskOf, parseGrant, permsOf, type GrantRow, type ParsedGrant } from "./grants.js";
import type { Actor } from "./model.js";
import { principalRefs, refOf } from "./present.js";

type Emit = (e: HubEvent) => void;

// ---------- channel paths ----------

/** Validates a channel path; an absent channel is `general`. */
export function normalizeChannel(path: string | undefined | null): string {
  if (path === undefined || path === null || path === "") return DEFAULT_CHANNEL;
  if (path.length > MAX_CHANNEL_CHARS || !CHANNEL_PATH_PATTERN.test(path)) {
    throw invalid(`Channel "${path.slice(0, 60)}" is not valid: use lowercase segments of letters, digits, '-' and '_' joined by '/'`, { field: "channel" });
  }
  return path;
}

/** Records that a channel exists. Caller holds a transaction. Returns true when this call created it. */
export function ensureChannel(ctx: AppContext, boardId: string, path: string, createdBy: string | null): boolean {
  return ctx.db.prepare("INSERT INTO channels (board_id, path, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(boardId, path, createdBy, nowIso(ctx)).changes > 0;
}

function hitWriteRate(ctx: AppContext, actor: Actor, boardId: string): void {
  const r = ctx.config.rateLimits;
  ctx.rate.hit(`w:p:${actor.id}`, r.writes_per_minute_principal, 60_000);
  ctx.rate.hit(`w:b:${boardId}`, r.writes_per_minute_board, 60_000);
}

// ---------- listing ----------

interface ChannelRow {
  board_id: string;
  path: string;
  created_at: string;
}

function presentChannels(ctx: AppContext, boardId: string, rows: ChannelRow[], access: ChannelAccess): Channel[] {
  if (rows.length === 0) return [];
  const stats = new Map(
    (ctx.db.prepare("SELECT channel, COUNT(*) AS n, MAX(last_activity_at) AS last FROM threads WHERE board_id = ? GROUP BY channel").all(boardId) as {
      channel: string;
      n: number;
      last: string | null;
    }[]).map((r) => [r.channel, r]),
  );
  const reader = ChannelAccess.forRole(boardId, "reader", access.grants);
  const contributor = ChannelAccess.forRole(boardId, "contributor", access.grants);
  return rows.map((r) => ({
    board_id: boardId,
    path: r.path,
    thread_count: stats.get(r.path)?.n ?? 0,
    last_activity_at: stats.get(r.path)?.last ?? null,
    private: !reader.can(r.path, "read") && !contributor.can(r.path, "read"),
    my_permissions: permsOf(access.mask(r.path)),
    created_at: r.created_at,
  }));
}

/** Channels the caller can read, sorted by path. */
export function listChannels(ctx: AppContext, actor: Actor, boardId: string): { channels: Channel[] } {
  requireMember(ctx, actor, boardId);
  const access = ChannelAccess.load(ctx, boardId, actor);
  const rows = (ctx.db.prepare("SELECT board_id, path, created_at FROM channels WHERE board_id = ? ORDER BY path").all(boardId) as ChannelRow[]).filter((r) =>
    access.can(r.path, "read"),
  );
  return { channels: presentChannels(ctx, boardId, rows, access) };
}

function channelRow(ctx: AppContext, boardId: string, path: string): ChannelRow | undefined {
  return ctx.db.prepare("SELECT board_id, path, created_at FROM channels WHERE board_id = ? AND path = ?").get(boardId, path) as ChannelRow | undefined;
}

// ---------- grants ----------

function isOwner(access: ChannelAccess): boolean {
  return access.subject?.role === "owner";
}

/** Owners manage every grant; others need `manage` at each pattern, and can't give more than they have there. */
function assertCanManage(access: ChannelAccess, patterns: Iterable<string>, giving?: Map<string, number>): void {
  if (isOwner(access)) return;
  for (const pattern of patterns) {
    if (!access.can(pattern, "manage")) throw forbidden(`You need manage at ${pattern} to change its grants`);
    const mask = giving?.get(pattern);
    if (mask !== undefined && (mask & ~access.mask(pattern)) !== 0) {
      throw forbidden(`You can't grant more than you have at ${pattern}: ${permsOf(mask & ~access.mask(pattern)).join(", ")}`);
    }
  }
}

function canManageAll(access: ChannelAccess, patterns: Iterable<string>): boolean {
  if (isOwner(access)) return true;
  for (const p of patterns) if (!access.can(p, "manage")) return false;
  return true;
}

function normalizeCan(can: GrantCanInput): Map<string, number> {
  const entries = Object.entries(can);
  if (entries.length === 0) throw invalid("can needs at least one pattern");
  if (entries.length > MAX_GRANT_PATTERNS) throw invalid(`A grant can name up to ${MAX_GRANT_PATTERNS} patterns`);
  const out = new Map<string, number>();
  for (const [pattern, perms] of entries) {
    if (pattern.length > MAX_CHANNEL_CHARS + 1 || !GRANT_PATTERN_PATTERN.test(pattern)) throw invalid(`Pattern "${pattern.slice(0, 60)}" is not '*', a channel, or a subtree ending in '/'`);
    if (perms !== "all" && perms !== "none" && (!Array.isArray(perms) || perms.some((p) => !(PERMISSIONS as readonly string[]).includes(p)))) {
      throw invalid(`Permissions at ${pattern} must be 'all', 'none' or a list of ${PERMISSIONS.join(", ")}`);
    }
    out.set(pattern, maskOf(perms));
  }
  return out;
}

const principalKey = (p: GrantPrincipal) => (p.kind === "member" ? `member:${p.principal_id}` : p.kind);

function normalizePrincipals(ctx: AppContext, boardId: string, list: GrantPrincipal[]): GrantPrincipal[] {
  const seen = new Map<string, GrantPrincipal>();
  for (const p of list) {
    if (p.kind === "member") {
      const row = getPrincipal(ctx, p.principal_id);
      if (!row || !activeMembership(ctx, boardId, { id: row.id, kind: row.kind, ownerId: row.owner_id })) {
        throw invalid(`Principal ${p.principal_id} is not a member of this board`, { principal_id: p.principal_id });
      }
      seen.set(principalKey(p), { kind: "member", principal_id: p.principal_id });
    } else seen.set(principalKey(p), { kind: p.kind });
  }
  if (seen.size > MAX_GRANT_PRINCIPALS) throw invalid(`A grant can name up to ${MAX_GRANT_PRINCIPALS} principals`);
  return [...seen.values()];
}

function canJson(can: Map<string, number>): string {
  return JSON.stringify(Object.fromEntries([...can].map(([p, m]) => [p, permsOf(m)])));
}

function presentGrants(ctx: AppContext, grants: ParsedGrant[]): Grant[] {
  const refs = principalRefs(ctx, grants.map((g) => g.row.created_by));
  return grants.map((g) => ({
    id: g.row.id,
    board_id: g.row.board_id,
    principals: g.principals,
    can: Object.fromEntries(g.can.map(([p, m]) => [p, permsOf(m)])) as Record<string, Permission[]>,
    created_by: refs.get(g.row.created_by)!,
    created_at: g.row.created_at,
    updated_at: g.row.updated_at,
  }));
}

function getGrantRow(ctx: AppContext, grantId: string): GrantRow | undefined {
  return ctx.db.prepare("SELECT * FROM grants WHERE id = ?").get(grantId) as GrantRow | undefined;
}

/** Grant changes go into the board's log as `board.updated` and wake live channels to re-check access. */
function grantsChanged(ctx: AppContext, emit: Emit, boardId: string, actorId: string): void {
  recordEvent(ctx, emit, { boardId, type: "board.updated", actorId });
  emit({ kind: "grants", boardId });
}

function insertGrant(ctx: AppContext, boardId: string, actorId: string, principals: GrantPrincipal[], can: Map<string, number>): GrantRow {
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE board_id = ?").get(boardId) as { n: number }).n;
  if (count >= MAX_GRANTS_PER_BOARD) throw invalid(`A board can have up to ${MAX_GRANTS_PER_BOARD} grants; revoke one first`);
  const now = nowIso(ctx);
  const id = newId("g");
  ctx.db
    .prepare("INSERT INTO grants (id, board_id, principals, can, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, boardId, JSON.stringify(principals), canJson(can), actorId, now, now);
  return getGrantRow(ctx, id)!;
}

/** Grants the caller can manage: every grant for the owner, otherwise those whose every pattern the caller manages. */
export function listGrants(ctx: AppContext, actor: Actor, boardId: string): { grants: Grant[] } {
  requireMember(ctx, actor, boardId);
  const access = ChannelAccess.load(ctx, boardId, actor);
  return { grants: presentGrants(ctx, access.grants.filter((g) => canManageAll(access, g.can.map(([p]) => p)))) };
}

export function createGrant(ctx: AppContext, actor: Actor, boardId: string, input: { principals: GrantPrincipal[]; can: GrantCanInput }): { grant: Grant } {
  hitWriteRate(ctx, actor, boardId);
  return tx(ctx, (emit) => {
    requireMember(ctx, actor, boardId);
    const access = ChannelAccess.load(ctx, boardId, actor);
    const can = normalizeCan(input.can);
    if (input.principals.length === 0) throw invalid("A grant needs at least one principal");
    const principals = normalizePrincipals(ctx, boardId, input.principals);
    assertCanManage(access, can.keys(), can);
    const row = insertGrant(ctx, boardId, actor.id, principals, can);
    grantsChanged(ctx, emit, boardId, actor.id);
    return { grant: presentGrants(ctx, [parseGrant(row)])[0]! };
  });
}

export function updateGrant(
  ctx: AppContext,
  actor: Actor,
  grantId: string,
  input: { add?: GrantPrincipal[] | undefined; remove?: GrantPrincipal[] | undefined; can?: GrantCanInput | undefined },
): { grant: Grant } {
  const boardId = getGrantRow(ctx, grantId)?.board_id;
  if (boardId) hitWriteRate(ctx, actor, boardId);
  return tx(ctx, (emit) => {
    const row = getGrantRow(ctx, grantId);
    if (!row) throw notFound("Grant");
    requireMember(ctx, actor, row.board_id, "reader", "Grant");
    const access = ChannelAccess.load(ctx, row.board_id, actor);
    const current = parseGrant(row);
    const currentPatterns = current.can.map(([p]) => p);
    if (!canManageAll(access, currentPatterns)) throw notFound("Grant");
    const can = input.can ? normalizeCan(input.can) : null;
    if (can) assertCanManage(access, can.keys(), can);
    const removing = new Set((input.remove ?? []).map(principalKey));
    const kept = current.principals.filter((p) => !removing.has(principalKey(p)));
    const principals = input.add?.length ? normalizePrincipals(ctx, row.board_id, [...kept, ...input.add]) : kept;
    if (principals.length === 0) throw invalid("A grant needs at least one principal; revoke it instead");
    if (principals.length > MAX_GRANT_PRINCIPALS) throw invalid(`A grant can name up to ${MAX_GRANT_PRINCIPALS} principals`);
    ctx.db
      .prepare("UPDATE grants SET principals = ?, can = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(principals), can ? canJson(can) : row.can, nowIso(ctx), row.id);
    grantsChanged(ctx, emit, row.board_id, actor.id);
    return { grant: presentGrants(ctx, [parseGrant(getGrantRow(ctx, row.id)!)])[0]! };
  });
}

export function revokeGrant(ctx: AppContext, actor: Actor, grantId: string): { grant_id: string; revoked: boolean } {
  const boardId = getGrantRow(ctx, grantId)?.board_id;
  if (boardId) hitWriteRate(ctx, actor, boardId);
  return tx(ctx, (emit) => {
    const row = getGrantRow(ctx, grantId);
    if (!row) throw notFound("Grant");
    requireMember(ctx, actor, row.board_id, "reader", "Grant");
    const access = ChannelAccess.load(ctx, row.board_id, actor);
    if (!canManageAll(access, parseGrant(row).can.map(([p]) => p))) throw notFound("Grant");
    ctx.db.prepare("DELETE FROM grants WHERE id = ?").run(row.id);
    grantsChanged(ctx, emit, row.board_id, actor.id);
    return { grant_id: row.id, revoked: true };
  });
}

// ---------- creating channels ----------

/**
 * Creates a channel before anything posts to it. Needs read and post there. With `private`, also closes it
 * (and everything under it) to everyone but the creator with two grants at `<path>/`; that needs manage there
 * and refuses when the channel, a channel under it, or a grant reaching it already exists.
 */
export function createChannel(ctx: AppContext, actor: Actor, boardId: string, input: { path: string; private?: boolean | undefined }): { channel: Channel; created: boolean; grants: Grant[] } {
  hitWriteRate(ctx, actor, boardId);
  const path = normalizeChannel(input.path);
  return tx(ctx, (emit) => {
    requireMember(ctx, actor, boardId);
    const access = ChannelAccess.load(ctx, boardId, actor);
    if (!input.private) {
      if (!access.can(path, "read") || !access.can(path, "post")) throw forbidden(`Creating ${path} needs read and post there`);
      const created = ensureChannel(ctx, boardId, path, actor.id);
      if (created) recordEvent(ctx, emit, { boardId, type: "board.updated", actorId: actor.id });
      return { channel: presentChannels(ctx, boardId, [channelRow(ctx, boardId, path)!], access)[0]!, created, grants: [] };
    }
    const subtree = `${path}/`;
    if (!isOwner(access) && !access.can(subtree, "manage")) throw forbidden(`A private channel needs manage at ${subtree}`);
    const existing = ctx.db.prepare("SELECT path FROM channels WHERE board_id = ? AND (path = ? OR substr(path, 1, ?) = ?) LIMIT 1").get(boardId, path, subtree.length, subtree) as
      | { path: string }
      | undefined;
    if (existing) throw new OmbError("conflict", `Channel ${existing.path} already exists, so ${path} can't be made private this way; use grants`, { reason: "channel_exists", channel: existing.path });
    const reaching = access.grants.find((g) => g.can.some(([p]) => p === path || p === subtree || p.startsWith(subtree)));
    if (reaching) throw new OmbError("conflict", `Grant ${reaching.row.id} already reaches ${path}; change it instead`, { reason: "channel_granted", grant_id: reaching.row.id });
    const creators: GrantPrincipal[] = [{ kind: "member", principal_id: actor.id }];
    if (actor.kind === "agent" && actor.ownerId) creators.push({ kind: "member", principal_id: actor.ownerId });
    const mine = insertGrant(ctx, boardId, actor.id, creators, new Map([[subtree, maskOf("all")]]));
    const closed = insertGrant(ctx, boardId, actor.id, [{ kind: "everyone" }], new Map([[subtree, 0]]));
    ensureChannel(ctx, boardId, path, actor.id);
    grantsChanged(ctx, emit, boardId, actor.id);
    const fresh = ChannelAccess.load(ctx, boardId, actor);
    return {
      channel: presentChannels(ctx, boardId, [channelRow(ctx, boardId, path)!], fresh)[0]!,
      created: true,
      grants: presentGrants(ctx, [parseGrant(mine), parseGrant(closed)]),
    };
  });
}

// ---------- explain ----------

export function explainAccess(ctx: AppContext, actor: Actor, boardId: string, channel: string, principalId?: string): AccessExplanation {
  const path = normalizeChannel(channel);
  requireMember(ctx, actor, boardId);
  const mine = ChannelAccess.load(ctx, boardId, actor);
  let access = mine;
  let target = actor.id;
  if (principalId && principalId !== actor.id) {
    if (!isOwner(mine) && !mine.can("*", "manage")) throw forbidden("Explaining someone else's access needs manage at *");
    const p = getPrincipal(ctx, principalId);
    if (!p) throw notFound("Member");
    access = ChannelAccess.load(ctx, boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id }, mine.grants);
    if (!access.subject) throw notFound("Member");
    target = p.id;
  }
  const subject = access.subject!;
  const d = decide(access.grants, subject, path);
  const personCap = access.person ? decide(access.grants, access.person, path).granted & ROLE_CAP[access.person.role] : null;
  return {
    board_id: boardId,
    channel: path,
    principal: refOf(ctx, target),
    role: subject.role,
    can: permsOf(access.mask(path)),
    pattern: d.pattern,
    level: d.level,
    grant_ids: d.grantIds,
    granted: permsOf(d.granted),
    role_cap: permsOf(ROLE_CAP[subject.role]),
    person_cap: personCap === null ? null : permsOf(personCap),
  };
}

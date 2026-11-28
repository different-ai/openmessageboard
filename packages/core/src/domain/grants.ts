import { PERMISSIONS, type GrantPrincipal, type Permission, type Role } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { boardInScope, cappedRole } from "../auth/scopes.js";
import type { Actor } from "./model.js";

/**
 * Per-channel access. A board role caps everything; grants open or narrow access per channel pattern.
 *
 * Resolution for a member and a channel, among the grants that name the member:
 *  1. the most specific pattern wins: the exact channel, then the longest subtree, then `*`;
 *  2. at that pattern the closest principal wins: the agent itself, then the person (an agent is reached by
 *     its person's member grants), then a role group, then `everyone`;
 *  3. grants tied there add up;
 *  4. the board role caps the result, and an agent never exceeds what its person can do in the channel.
 * A profile (an agent principal that acts with its person's membership) resolves exactly as its person. A scoped
 * token sees only its boards, its role is capped (`cappedRole`), and it never gets more than its `can` (no `manage`).
 * With no grant naming the member at any matching pattern, the role's defaults apply (a board with no grants
 * behaves exactly as before grants existed).
 *
 * This module only reads the database and never imports access.ts, so access checks can use it.
 */

const BIT: Record<Permission, number> = { read: 1, post: 2, react: 4, label: 8, manage: 16 };
export const ALL_PERMISSIONS = 31;

/** What each role gets where no grant decides. */
export const ROLE_DEFAULT: Record<Role, number> = { reader: BIT.read | BIT.react, contributor: BIT.read | BIT.post | BIT.react | BIT.label, owner: ALL_PERMISSIONS };
/** Who is asking: a principal row or the authenticated actor (with a profile and a token scope, when set). */
export type AccessPrincipal = Pick<Actor, "id" | "kind" | "ownerId"> & Partial<Pick<Actor, "profile" | "scope">>;

/** The most each role can ever get. Contributors can be given `manage` by a grant; readers only read and react. */
export const ROLE_CAP: Record<Role, number> = { reader: BIT.read | BIT.react, contributor: ALL_PERMISSIONS, owner: ALL_PERMISSIONS };

export function bit(p: Permission): number {
  return BIT[p];
}

export function maskOf(perms: readonly Permission[] | "all" | "none"): number {
  if (perms === "all") return ALL_PERMISSIONS;
  if (perms === "none") return 0;
  let m = 0;
  for (const p of perms) m |= BIT[p];
  return m;
}

export function permsOf(mask: number): Permission[] {
  return PERMISSIONS.filter((p) => (mask & BIT[p]) !== 0);
}

// ---------- patterns ----------

/** Exact channel > longer subtree > shorter subtree > `*`. */
export function specificity(pattern: string): number {
  if (pattern === "*") return 0;
  const subtree = pattern.endsWith("/");
  const depth = (subtree ? pattern.slice(0, -1) : pattern).split("/").length;
  return depth * 2 - (subtree ? 1 : 0);
}

/**
 * Whether a grant pattern reaches a target: a channel path, a subtree (`a/`) or `*`.
 * A subtree pattern `a/` covers the channel `a` itself and every channel under it.
 */
export function covers(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  if (target === "*") return false;
  const t = target.endsWith("/") ? target.slice(0, -1) : target;
  const targetIsSubtree = target.endsWith("/");
  if (pattern.endsWith("/")) {
    const p = pattern.slice(0, -1);
    return t === p || t.startsWith(p + "/");
  }
  return !targetIsSubtree && t === pattern;
}

/** Whether a channel matches a filter: an exact path, or a path ending in `/` for its subtree. */
export function channelMatches(filter: string, channel: string): boolean {
  if (!filter.endsWith("/")) return channel === filter;
  const p = filter.slice(0, -1);
  return channel === p || channel.startsWith(filter);
}

// ---------- grants ----------

export interface GrantRow {
  id: string;
  board_id: string;
  principals: string;
  can: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ParsedGrant {
  row: GrantRow;
  principals: GrantPrincipal[];
  /** [pattern, permission mask], in the order they were given. */
  can: [string, number][];
}

export function parseGrant(row: GrantRow): ParsedGrant {
  let principals: GrantPrincipal[] = [];
  let can: Record<string, Permission[]> = {};
  try {
    principals = JSON.parse(row.principals) as GrantPrincipal[];
    can = JSON.parse(row.can) as Record<string, Permission[]>;
  } catch {
    /* a malformed row grants nothing */
  }
  return { row, principals, can: Object.entries(can).map(([pattern, perms]) => [pattern, maskOf(perms)]) };
}

export function loadGrants(ctx: AppContext, boardId: string): ParsedGrant[] {
  return (ctx.db.prepare("SELECT * FROM grants WHERE board_id = ? ORDER BY created_at, id").all(boardId) as GrantRow[]).map(parseGrant);
}

// ---------- subjects ----------

export interface Subject {
  id: string;
  kind: Actor["kind"];
  role: Role;
  /** Agents: the person they act for. */
  ownerId: string | null;
}

export type Level = "agent" | "member" | "role_group" | "everyone";
const LEVEL_RANK: Record<Level, number> = { agent: 4, member: 3, role_group: 2, everyone: 1 };

function levelFor(g: ParsedGrant, s: Subject): Level | null {
  let best: Level | null = null;
  const consider = (l: Level) => {
    if (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
  };
  for (const p of g.principals) {
    if (p.kind === "member") {
      if (p.principal_id === s.id) consider(s.kind === "agent" ? "agent" : "member");
      else if (s.kind === "agent" && s.ownerId && p.principal_id === s.ownerId) consider("member");
    } else if (p.kind === "everyone") consider("everyone");
    else if ((p.kind === "readers" && s.role === "reader") || (p.kind === "contributors" && s.role === "contributor")) consider("role_group");
  }
  return best;
}

// ---------- the public ----------

/** A grant that names the public: everyone signed in who is not a member (11 §Public access). */
export const isPublicGrant = (g: ParsedGrant): boolean => g.principals.some((p) => p.kind === "public");

/**
 * What public grants give at a channel: among the public grants whose pattern covers it, the most specific pattern
 * decides, as for members, so `read` at `*` with nothing at `internal/` opens everything else. Never more than
 * `read`, whatever a stored grant says.
 *
 * A public grant does not open what a closer grant closes to plain readers. A private channel is closed to
 * `everyone` at its own subtree, so `read` for the public at `*` leaves it private; the owner opens it to the
 * public only by naming it, or something under it.
 */
export function publicDecision(grants: ParsedGrant[], target: string): { pattern: string | null; grantIds: string[]; mask: number } {
  const nothing = { pattern: null, grantIds: [], mask: 0 };
  let bestSpec = -1;
  let out: { pattern: string | null; grantIds: string[]; mask: number } = nothing;
  for (const g of grants) {
    if (!isPublicGrant(g)) continue;
    for (const [pattern, mask] of g.can) {
      if (!covers(pattern, target)) continue;
      const spec = specificity(pattern);
      if (spec > bestSpec) {
        bestSpec = spec;
        out = { pattern, grantIds: [g.row.id], mask };
      } else if (spec === bestSpec) {
        if (!out.grantIds.includes(g.row.id)) out.grantIds.push(g.row.id);
        out.mask |= mask;
      }
    }
  }
  if ((out.mask & BIT.read) === 0) return out.pattern === null ? nothing : { ...out, mask: 0 };
  const members = decide(grants, PLAIN_READER, target);
  if (members.pattern !== null && (members.granted & BIT.read) === 0 && specificity(members.pattern) > bestSpec) return nothing;
  return { ...out, mask: BIT.read };
}

export const publicMask = (grants: ParsedGrant[], target: string): number => publicDecision(grants, target).mask;

/** Whether a public grant gives `read` at some pattern: the board is public. */
export const hasPublicRead = (grants: ParsedGrant[]): boolean => grants.some((g) => isPublicGrant(g) && g.can.some(([, mask]) => (mask & BIT.read) !== 0));

/**
 * Whether `principal`, who is not counted as a member here, may read the board's public channels.
 * - The server offers public access, the board is not disabled and has a public grant that gives `read`.
 * - A scoped token reaches only its boards.
 * - A person may. An agent or a profile may only when its person saved the board: a board address in a message
 *   must not pull an agent onto a board its person never chose, for the reason agents cannot redeem invites.
 * - A disabled principal, or the agent of one, may not.
 */
export function isPublicReader(ctx: AppContext, boardId: string, principal: AccessPrincipal, grants?: ParsedGrant[]): boolean {
  if (!ctx.config.publicAccess || !boardInScope(principal, boardId)) return false;
  if (principal.kind !== "human" && principal.kind !== "agent") return false;
  const board = ctx.db.prepare("SELECT disabled_at FROM boards WHERE id = ?").get(boardId) as { disabled_at: string | null } | undefined;
  if (!board || board.disabled_at) return false;
  if (!hasPublicRead(grants ?? loadGrants(ctx, boardId))) return false;
  const enabled = (id: string) => (ctx.db.prepare("SELECT disabled_at FROM principals WHERE id = ?").get(id) as { disabled_at: string | null } | undefined)?.disabled_at === null;
  if (!enabled(principal.id)) return false;
  if (principal.kind === "human") return true;
  if (!principal.ownerId || !enabled(principal.ownerId)) return false;
  return ctx.db.prepare("SELECT 1 FROM saved_boards WHERE principal_id = ? AND board_id = ?").get(principal.ownerId, boardId) !== undefined;
}

/** A member with the reader role and no grant naming them: what "closed to plain readers" is measured against. */
const PLAIN_READER: Subject = { id: "", kind: "human", role: "reader", ownerId: null };

export interface Decision {
  pattern: string | null;
  level: Level | null;
  grantIds: string[];
  /** What the deciding grants (or the role's defaults) give, before caps. */
  granted: number;
}

export function decide(grants: ParsedGrant[], s: Subject, target: string): Decision {
  let bestSpec = -1;
  let bestLevel = 0;
  let decision: Decision = { pattern: null, level: null, grantIds: [], granted: ROLE_DEFAULT[s.role] };
  for (const g of grants) {
    const level = levelFor(g, s);
    if (!level) continue;
    const rank = LEVEL_RANK[level];
    for (const [pattern, mask] of g.can) {
      if (!covers(pattern, target)) continue;
      const spec = specificity(pattern);
      if (spec > bestSpec || (spec === bestSpec && rank > bestLevel)) {
        bestSpec = spec;
        bestLevel = rank;
        decision = { pattern, level, grantIds: [g.row.id], granted: mask };
      } else if (spec === bestSpec && rank === bestLevel) {
        if (!decision.grantIds.includes(g.row.id)) decision.grantIds.push(g.row.id);
        decision.granted |= mask;
      }
    }
  }
  return decision;
}

interface MemberInfo {
  role: Role;
  access_ends_at: string | null;
}

function activeRole(ctx: AppContext, boardId: string, principalId: string): Role | null {
  const m = ctx.db.prepare("SELECT role, access_ends_at FROM memberships WHERE board_id = ? AND principal_id = ?").get(boardId, principalId) as MemberInfo | undefined;
  if (!m) return null;
  if (m.access_ends_at !== null && m.access_ends_at <= ctx.now().toISOString()) return null;
  return m.role;
}

/**
 * One principal's access on one board, resolved once and cached per channel. Build one per request (or per
 * live connection, rebuilt when grants or roles change) and ask it about as many channels as needed.
 */
export class ChannelAccess {
  private readonly cache = new Map<string, number>();

  private constructor(
    readonly boardId: string,
    readonly subject: Subject | null,
    readonly person: Subject | null,
    readonly grants: ParsedGrant[],
    /** A scoped token's permissions; everything else is masked out. */
    private readonly tokenMask: number = ALL_PERMISSIONS,
    /** Not a member: reads only what public grants open (11 §Public access). Only `loadReader` sets it. */
    readonly publicReader: boolean = false,
    /** Whether the server offers public access. When it does not, stored public grants open nothing, to anyone. */
    readonly publicOn: boolean = true,
  ) {}

  /**
   * Resolves `principal`'s membership (and, for agents, its person's) on the board. Non-members, and boards outside
   * a scoped token, can do nothing. A profile resolves as its person.
   */
  static load(ctx: AppContext, boardId: string, principal: AccessPrincipal, grants?: ParsedGrant[]): ChannelAccess {
    const none = new ChannelAccess(boardId, null, null, []);
    if (!boardInScope(principal, boardId)) return none;
    const asPerson = !!principal.profile && !!principal.ownerId;
    const id = asPerson ? principal.ownerId! : principal.id;
    const found = activeRole(ctx, boardId, id);
    if (!found) return none;
    const role = cappedRole(principal, found);
    const subject: Subject = asPerson ? { id, kind: "human", role, ownerId: null } : { id, kind: principal.kind, role, ownerId: principal.ownerId };
    let person: Subject | null = null;
    if (!asPerson && principal.kind === "agent" && principal.ownerId) {
      const ownerRole = activeRole(ctx, boardId, principal.ownerId);
      if (!ownerRole) return none;
      person = { id: principal.ownerId, kind: "human", role: ownerRole, ownerId: null };
    }
    const tokenMask = principal.scope ? maskOf(principal.scope.can) : ALL_PERMISSIONS;
    return new ChannelAccess(boardId, subject, person, grants ?? loadGrants(ctx, boardId), tokenMask, false, ctx.config.publicAccess);
  }

  /**
   * `load`, and for a principal who is not a member, what public grants let it read. Only the read paths the
   * specification opens to the public call this (11 §Public access); everything else calls `load`, where a
   * principal who is not a member can do nothing.
   */
  static loadReader(ctx: AppContext, boardId: string, principal: AccessPrincipal, grants?: ParsedGrant[]): ChannelAccess {
    const access = ChannelAccess.load(ctx, boardId, principal, grants);
    if (access.isMember) return access;
    const all = grants ?? loadGrants(ctx, boardId);
    if (!isPublicReader(ctx, boardId, principal, all)) return access;
    return new ChannelAccess(boardId, null, null, all, ALL_PERMISSIONS, true, true);
  }

  /** Builds access for a known role without reading the membership (used for synthetic members). */
  static forRole(boardId: string, role: Role, grants: ParsedGrant[], id = "", publicOn = true): ChannelAccess {
    return new ChannelAccess(boardId, { id, kind: "human", role, ownerId: null }, null, grants, ALL_PERMISSIONS, false, publicOn);
  }

  get isMember(): boolean {
    return this.subject !== null;
  }

  /** True when the board has no grants, so every channel gets the same answer. */
  get uniform(): boolean {
    return this.grants.length === 0;
  }

  /** Permission mask at a channel path, a subtree pattern (`a/`) or `*`. */
  /**
   * Permission mask at a channel path, a subtree pattern (`a/`) or `*`, from the principal's own grants and role.
   * For a member this leaves the public's access out, so that "what you have at a pattern" (who may manage it,
   * what one may grant there) never grows because the public can read. `channelMask` and `can` add it for channels.
   */
  mask(target: string): number {
    if (!this.subject) return this.publicReader ? this.publicBits(target) : 0;
    const key = this.uniform ? "*" : target;
    let m = this.cache.get(key);
    if (m === undefined) {
      m = decide(this.grants, this.subject, target).granted & ROLE_CAP[this.subject.role];
      if (this.person) m &= decide(this.grants, this.person, target).granted & ROLE_CAP[this.person.role];
      m &= this.tokenMask;
      this.cache.set(key, m);
    }
    return m;
  }

  /** What public grants open at a channel, when the server offers public access. */
  private publicBits(target: string): number {
    return this.publicOn ? publicMask(this.grants, target) : 0;
  }

  /** Whether people who are not members can read this channel. */
  publicCanRead(channel: string): boolean {
    return this.publicBits(channel) !== 0;
  }

  /**
   * What the principal can do in one channel. A member is never worse off than the public: what anyone signed in
   * may read there, a member may read, whatever other grants say.
   */
  channelMask(channel: string): number {
    return this.subject ? this.mask(channel) | this.publicBits(channel) : this.mask(channel);
  }

  can(target: string, perm: Permission): boolean {
    const isChannel = target !== "*" && !target.endsWith("/");
    return ((isChannel ? this.channelMask(target) : this.mask(target)) & BIT[perm]) !== 0;
  }

  /**
   * Channels on the board the principal can read, for SQL filters. Returns null when every channel is readable
   * (no filter needed). Threads whose channel has no row are left out, so an unknown channel fails closed.
   */
  readableChannels(ctx: AppContext): string[] | null {
    return this.allowedChannels(ctx, "read");
  }

  /** Like readableChannels, for channels where the principal has every one of `perms`. */
  allowedChannels(ctx: AppContext, ...perms: Permission[]): string[] | null {
    if (!this.subject && !this.publicReader) return [];
    const ok = (target: string) => perms.every((p) => this.can(target, p));
    // The public gets an explicit list, never "every channel", so a thread whose channel has no row stays hidden.
    if (this.publicReader) return (ctx.db.prepare("SELECT path FROM channels WHERE board_id = ?").all(this.boardId) as { path: string }[]).map((r) => r.path).filter(ok);
    if (this.uniform) return ok("*") ? null : [];
    const paths = (ctx.db.prepare("SELECT path FROM channels WHERE board_id = ?").all(this.boardId) as { path: string }[]).map((r) => r.path);
    const allowed = paths.filter(ok);
    return allowed.length === paths.length ? null : allowed;
  }
}

/** Access per board for one principal, loaded lazily (inbox items span boards). */
export class AccessCache {
  private readonly boards = new Map<string, ChannelAccess>();
  constructor(
    private readonly ctx: AppContext,
    private readonly principal: AccessPrincipal,
  ) {}
  for(boardId: string): ChannelAccess {
    let a = this.boards.get(boardId);
    if (!a) {
      a = ChannelAccess.load(this.ctx, boardId, this.principal);
      this.boards.set(boardId, a);
    }
    return a;
  }
  canRead(boardId: string, channel: string): boolean {
    return this.for(boardId).can(channel, "read");
  }
}

/** SQL that keeps rows whose channel column is readable; empty when no filter is needed. */
export function readableSql(column: string, readable: string[] | null, params: unknown[]): string {
  if (readable === null) return "";
  if (readable.length === 0) return " AND 0";
  params.push(JSON.stringify(readable));
  return ` AND ${column} IN (SELECT value FROM json_each(?))`;
}

/** SQL for a channel filter: an exact path, or a path ending in `/` for the channel and its subtree. */
export function channelFilterSql(column: string, filter: string | undefined, params: unknown[]): string {
  if (!filter) return "";
  if (!filter.endsWith("/")) {
    params.push(filter);
    return ` AND ${column} = ?`;
  }
  const base = filter.slice(0, -1);
  params.push(base, filter.length, filter);
  return ` AND (${column} = ? OR substr(${column}, 1, ?) = ?)`;
}

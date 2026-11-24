import { PERMISSIONS, type GrantPrincipal, type Permission, type Role } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
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
 * With no grant naming the member at any matching pattern, the role's defaults apply (a board with no grants
 * behaves exactly as before grants existed).
 *
 * This module only reads the database and never imports access.ts, so access checks can use it.
 */

const BIT: Record<Permission, number> = { read: 1, post: 2, react: 4, label: 8, manage: 16 };
export const ALL_PERMISSIONS = 31;

/** What each role gets where no grant decides. */
export const ROLE_DEFAULT: Record<Role, number> = { reader: BIT.read | BIT.react, contributor: BIT.read | BIT.post | BIT.react | BIT.label, owner: ALL_PERMISSIONS };
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
  ) {}

  /** Resolves `principal`'s membership (and, for agents, its person's) on the board. Non-members can do nothing. */
  static load(ctx: AppContext, boardId: string, principal: { id: string; kind: Actor["kind"]; ownerId: string | null }, grants?: ParsedGrant[]): ChannelAccess {
    const role = activeRole(ctx, boardId, principal.id);
    if (!role) return new ChannelAccess(boardId, null, null, []);
    const subject: Subject = { id: principal.id, kind: principal.kind, role, ownerId: principal.ownerId };
    let person: Subject | null = null;
    if (principal.kind === "agent" && principal.ownerId) {
      const ownerRole = activeRole(ctx, boardId, principal.ownerId);
      if (!ownerRole) return new ChannelAccess(boardId, null, null, []);
      person = { id: principal.ownerId, kind: "human", role: ownerRole, ownerId: null };
    }
    return new ChannelAccess(boardId, subject, person, grants ?? loadGrants(ctx, boardId));
  }

  /** Builds access for a known role without reading the membership (used for synthetic members). */
  static forRole(boardId: string, role: Role, grants: ParsedGrant[], id = ""): ChannelAccess {
    return new ChannelAccess(boardId, { id, kind: "human", role, ownerId: null }, null, grants);
  }

  get isMember(): boolean {
    return this.subject !== null;
  }

  /** True when the board has no grants, so every channel gets the same answer. */
  get uniform(): boolean {
    return this.grants.length === 0;
  }

  /** Permission mask at a channel path, a subtree pattern (`a/`) or `*`. */
  mask(target: string): number {
    if (!this.subject) return 0;
    const key = this.uniform ? "*" : target;
    let m = this.cache.get(key);
    if (m === undefined) {
      m = decide(this.grants, this.subject, target).granted & ROLE_CAP[this.subject.role];
      if (this.person) m &= decide(this.grants, this.person, target).granted & ROLE_CAP[this.person.role];
      this.cache.set(key, m);
    }
    return m;
  }

  can(target: string, perm: Permission): boolean {
    return (this.mask(target) & BIT[perm]) !== 0;
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
    if (!this.subject) return [];
    const ok = (target: string) => perms.every((p) => this.can(target, p));
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
    private readonly principal: { id: string; kind: Actor["kind"]; ownerId: string | null },
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

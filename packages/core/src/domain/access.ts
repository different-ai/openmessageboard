import { ROLE_RANK, type Permission, type Role } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, forbidden, notFound } from "../errors.js";
import { boardInScope, cappedRole } from "../auth/scopes.js";
import type { Actor, BoardRow, MembershipRow, PrincipalRow, ThreadRow } from "./model.js";
import { ChannelAccess, isPublicReader } from "./grants.js";

export const nowIso = (ctx: AppContext) => ctx.now().toISOString();

export function getPrincipal(ctx: AppContext, id: string): PrincipalRow | undefined {
  return ctx.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as PrincipalRow | undefined;
}

export function getBoardRow(ctx: AppContext, id: string): BoardRow | undefined {
  return ctx.db.prepare("SELECT * FROM boards WHERE id = ? AND disabled_at IS NULL").get(id) as BoardRow | undefined;
}

export function getMembership(ctx: AppContext, boardId: string, principalId: string): MembershipRow | undefined {
  return ctx.db.prepare("SELECT * FROM memberships WHERE board_id = ? AND principal_id = ?").get(boardId, principalId) as MembershipRow | undefined;
}

export function isExpired(ctx: AppContext, m: Pick<MembershipRow, "access_ends_at">): boolean {
  return m.access_ends_at !== null && m.access_ends_at <= nowIso(ctx);
}

/** The principal whose membership decides access: a profile acts with its person's membership. */
export function holderId(principal: Pick<Actor, "id" | "ownerId" | "profile">): string {
  return principal.profile && principal.ownerId ? principal.ownerId : principal.id;
}

type AccessSubject = Pick<Actor, "id" | "kind" | "ownerId"> & Partial<Pick<Actor, "profile" | "scope">>;

/** A membership that currently grants access, including the agent's owner check, a profile's person and a token's boards. */
export function activeMembership(ctx: AppContext, boardId: string, principal: AccessSubject): MembershipRow | undefined {
  if (!boardInScope(principal, boardId)) return undefined;
  const m = getMembership(ctx, boardId, holderId(principal));
  if (!m || isExpired(ctx, m)) return undefined;
  if (principal.kind === "agent" && principal.ownerId && !principal.profile) {
    const owner = getMembership(ctx, boardId, principal.ownerId);
    if (!owner || isExpired(ctx, owner)) return undefined;
  }
  return m;
}

export interface MemberAccess {
  board: BoardRow;
  membership: MembershipRow;
}

/**
 * Checks the caller's access to a board. A profile uses its person's membership; a scoped token sees only its
 * boards (others are `not_found`) and its role is capped (the returned membership carries the capped role).
 */
export function requireMember(ctx: AppContext, actor: Actor, boardId: string, min: Role = "reader", what = "Board"): MemberAccess {
  const board = getBoardRow(ctx, boardId);
  if (!board || !boardInScope(actor, boardId)) throw notFound(what);
  const found = getMembership(ctx, boardId, holderId(actor));
  if (!found) {
    // Someone reading a public board named it themselves, so its existence is no secret: what they may not do is
    // `forbidden`. Only when the caller named the board; a board reached through another object's ID stays
    // `not_found`, so that nothing about a thread or a message in a channel the public cannot read is revealed.
    if (what === "Board" && isPublicReader(ctx, boardId, actor)) throw forbidden(MEMBERS_ONLY);
    throw notFound(what);
  }
  if (actor.via !== "system" && getPrincipal(ctx, actor.id)?.disabled_at) throw new OmbError("access_ended", "This account is disabled");
  if (isExpired(ctx, found)) throw new OmbError("access_ended", "Your access to this board has ended", { access_ends_at: found.access_ends_at });
  if (actor.kind === "agent" && actor.ownerId && !actor.profile) {
    const owner = getMembership(ctx, boardId, actor.ownerId);
    if (!owner || isExpired(ctx, owner)) throw new OmbError("access_ended", "The person this agent acts for no longer has access");
  }
  const role = cappedRole(actor, found.role);
  const m = role === found.role ? found : { ...found, role };
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) {
    if (role !== found.role) throw forbidden(`This token is limited to ${actor.scope!.can.join(", ")}`);
    throw forbidden(min === "owner" ? "Only the board owner can do that" : `This needs the ${min} role; you are a ${m.role}`);
  }
  return { board, membership: m };
}

const MEMBERS_ONLY = "That needs membership of this board; you are reading it through a public grant";

export interface ReaderAccess {
  board: BoardRow;
  /** null for someone reading through a public grant (11 §Public access). */
  membership: MembershipRow | null;
  channels: ChannelAccess;
}

/**
 * The caller's access to a board for the reads the specification opens to the public: a member, or someone who is
 * not a member and may read what the board's public grants open. Everything else calls `requireMember`.
 */
export function requireReader(ctx: AppContext, actor: Actor, boardId: string, what = "Board"): ReaderAccess {
  let member: MemberAccess | undefined;
  try {
    member = requireMember(ctx, actor, boardId, "reader", what);
  } catch (e) {
    // Not a member, or a membership that ended: the public's access is what is left, where there is any.
    if (!(e instanceof OmbError) || (e.code !== "not_found" && e.code !== "forbidden" && e.code !== "access_ended")) throw e;
    const channels = ChannelAccess.loadReader(ctx, boardId, actor);
    if (!channels.publicReader) {
      if (e.code === "forbidden") throw notFound(what);
      throw e;
    }
    return { board: getBoardRow(ctx, boardId)!, membership: null, channels };
  }
  return { ...member, channels: ChannelAccess.load(ctx, boardId, actor) };
}

export interface ThreadAccess extends MemberAccess {
  thread: ThreadRow;
  /** The caller's access on the thread's board, resolved once. */
  channels: ChannelAccess;
}

/** A thread the caller can read. A thread in a channel the caller can't read is `not_found`, like one on another board. */
export function requireThread(ctx: AppContext, actor: Actor, threadId: string, min: Role = "reader"): ThreadAccess {
  const thread = ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
  if (!thread) throw notFound("Thread");
  let access: MemberAccess;
  try {
    access = requireMember(ctx, actor, thread.board_id, "reader", "Thread");
  } catch (e) {
    // Someone who can read this thread through a public grant knows it exists: acting on it is `forbidden`.
    // A thread in a channel the public cannot read stays `not_found`.
    if (e instanceof OmbError && e.code === "not_found") {
      const reader = ChannelAccess.loadReader(ctx, thread.board_id, actor);
      if (reader.publicReader && reader.can(thread.channel, "read")) throw forbidden(MEMBERS_ONLY);
    }
    throw e;
  }
  const channels = ChannelAccess.load(ctx, thread.board_id, actor);
  if (!channels.can(thread.channel, "read")) throw notFound("Thread");
  if (ROLE_RANK[access.membership.role] < ROLE_RANK[min]) {
    throw forbidden(min === "owner" ? "Only the board owner can do that" : `This needs the ${min} role; you are a ${access.membership.role}`);
  }
  return { ...access, thread, channels };
}

export interface ThreadReaderAccess extends ReaderAccess {
  thread: ThreadRow;
}

/** A thread the caller can read, as a member or through a public grant. For the reads opened to the public only. */
export function requireThreadReader(ctx: AppContext, actor: Actor, threadId: string): ThreadReaderAccess {
  const thread = ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
  if (!thread) throw notFound("Thread");
  const access = requireReader(ctx, actor, thread.board_id, "Thread");
  if (!access.channels.can(thread.channel, "read")) throw notFound("Thread");
  return { ...access, thread };
}

/** Throws `forbidden` unless the caller has `perm` in the thread's channel. */
export function requireChannelPermission(t: Pick<ThreadAccess, "thread" | "channels">, perm: Permission): void {
  if (!t.channels.can(t.thread.channel, perm)) throw forbidden(`You can't ${perm} in ${t.thread.channel}`);
}

export function requireHuman(actor: Actor, message = "Only people can do that; agents act through the person they belong to"): void {
  if (actor.kind !== "human") throw forbidden(message);
}

export function actorFromPrincipal(p: PrincipalRow, via: Actor["via"], clientId?: string): Actor {
  return {
    id: p.id,
    kind: p.kind,
    displayName: p.display_name,
    ownerId: p.owner_id,
    email: p.email,
    via,
    ...(clientId ? { clientId } : {}),
    ...(p.profile_name ? { profile: p.profile_name } : {}),
  };
}

export function currentMonth(ctx: AppContext): string {
  return nowIso(ctx).slice(0, 7);
}

export function nextMonthStart(ctx: AppContext): string {
  const d = ctx.now();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

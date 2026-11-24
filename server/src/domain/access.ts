import { ROLE_RANK, type Role } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, forbidden, notFound } from "../errors.js";
import type { Actor, BoardRow, MembershipRow, PrincipalRow, ThreadRow } from "./model.js";

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

/** A membership that currently grants access, including the agent's owner check. */
export function activeMembership(ctx: AppContext, boardId: string, principal: Pick<Actor, "id" | "kind" | "ownerId">): MembershipRow | undefined {
  const m = getMembership(ctx, boardId, principal.id);
  if (!m || isExpired(ctx, m)) return undefined;
  if (principal.kind === "agent" && principal.ownerId) {
    const owner = getMembership(ctx, boardId, principal.ownerId);
    if (!owner || isExpired(ctx, owner)) return undefined;
  }
  return m;
}

export interface MemberAccess {
  board: BoardRow;
  membership: MembershipRow;
}

export function requireMember(ctx: AppContext, actor: Actor, boardId: string, min: Role = "reader", what = "Board"): MemberAccess {
  const board = getBoardRow(ctx, boardId);
  if (!board) throw notFound(what);
  const m = getMembership(ctx, boardId, actor.id);
  if (!m) throw notFound(what);
  if (actor.via !== "system" && getPrincipal(ctx, actor.id)?.disabled_at) throw new OmbError("access_ended", "This account is disabled");
  if (isExpired(ctx, m)) throw new OmbError("access_ended", "Your access to this board has ended", { access_ends_at: m.access_ends_at });
  if (actor.kind === "agent" && actor.ownerId) {
    const owner = getMembership(ctx, boardId, actor.ownerId);
    if (!owner || isExpired(ctx, owner)) throw new OmbError("access_ended", "The person this agent acts for no longer has access");
  }
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) {
    throw forbidden(min === "owner" ? "Only the board owner can do that" : `This needs the ${min} role; you are a ${m.role}`);
  }
  return { board, membership: m };
}

export interface ThreadAccess extends MemberAccess {
  thread: ThreadRow;
}

export function requireThread(ctx: AppContext, actor: Actor, threadId: string, min: Role = "reader"): ThreadAccess {
  const thread = ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
  if (!thread) throw notFound("Thread");
  return { ...requireMember(ctx, actor, thread.board_id, min, "Thread"), thread };
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
  };
}

export function currentMonth(ctx: AppContext): string {
  return nowIso(ctx).slice(0, 7);
}

export function nextMonthStart(ctx: AppContext): string {
  const d = ctx.now();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

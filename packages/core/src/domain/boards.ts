import {
  ROLE_RANK,
  type Board,
  type Member,
  type Membership,
  type Agent,
  type CreatedToken,
  type EventType,
  type PersonalToken,
  type TokenPermission,
  type TokenScope,
  boardUrl,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import { newId, randomToken, sha256 } from "../ids.js";
import type { HubEvent } from "../live/hub.js";
import { getBoardRow, getMembership, getPrincipal, holderId, isExpired, nowIso, requireHuman, requireMember, requireReader } from "./access.js";
import { boardInScope, cappedRole } from "../auth/scopes.js";
import type { Actor, BoardRow, MembershipRow, PrincipalRow } from "./model.js";
import { presentBoard, presentMember, principalRefs } from "./present.js";
import { boardLimits, limitsFor } from "./plans.js";
import { boardAttachmentKeys, removeFiles } from "./attachments.js";
import { releaseClaimsOf } from "./tasks.js";

// ---------- principals ----------

/** Finds or creates the human principal for a verified email (sign-in, test identities). */
export function ensureHuman(ctx: AppContext, input: { email: string; displayName?: string; authUserId?: string }): PrincipalRow {
  const email = input.email.trim().toLowerCase();
  const existing = ctx.db.prepare("SELECT * FROM principals WHERE email = ? AND kind = 'human'").get(email) as PrincipalRow | undefined;
  if (existing) {
    if (input.authUserId && existing.auth_user_id !== input.authUserId) {
      ctx.db.prepare("UPDATE principals SET auth_user_id = ? WHERE id = ?").run(input.authUserId, existing.id);
      existing.auth_user_id = input.authUserId;
    }
    return existing;
  }
  const row: PrincipalRow = {
    id: newId("p"),
    kind: "human",
    display_name: (input.displayName?.trim() || email.split("@")[0]!).slice(0, 60),
    email,
    owner_id: null,
    auth_user_id: input.authUserId ?? null,
    disabled_at: null,
    created_at: nowIso(ctx),
  };
  ctx.db
    .prepare(
      "INSERT INTO principals (id, kind, display_name, email, owner_id, auth_user_id, disabled_at, created_at) VALUES (@id, @kind, @display_name, @email, @owner_id, @auth_user_id, @disabled_at, @created_at) ON CONFLICT(email) DO NOTHING",
    )
    .run(row);
  return ctx.db.prepare("SELECT * FROM principals WHERE email = ?").get(email) as PrincipalRow;
}

export function setDisplayName(ctx: AppContext, actor: Actor, name: string): void {
  const n = name.trim();
  if (!n || n.length > 60) throw invalid("Display name must be 1-60 characters");
  ctx.db.prepare("UPDATE principals SET display_name = ? WHERE id = ?").run(n, actor.id);
}

// ---------- handles ----------

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || "member";
}

function uniqueHandle(ctx: AppContext, boardId: string, base: string): string {
  const s = slug(base);
  const taken = new Set(
    (ctx.db.prepare("SELECT handle FROM memberships WHERE board_id = ? AND (handle = ? OR handle LIKE ?)").all(boardId, s, `${s}-%`) as { handle: string }[]).map(
      (r) => r.handle,
    ),
  );
  if (!taken.has(s)) return s;
  for (let i = 2; ; i++) if (!taken.has(`${s}-${i}`)) return `${s}-${i}`;
}

function insertMembership(
  ctx: AppContext,
  boardId: string,
  principal: PrincipalRow,
  role: MembershipRow["role"],
  extra: { addedBy?: string | null; viaInviteId?: string | null; accessEndsAt?: string | null } = {},
): MembershipRow {
  const row: MembershipRow = {
    board_id: boardId,
    principal_id: principal.id,
    role,
    handle: uniqueHandle(ctx, boardId, principal.display_name),
    added_by: extra.addedBy ?? null,
    via_invite_id: extra.viaInviteId ?? null,
    access_ends_at: extra.accessEndsAt ?? null,
    expiry_notified: 0,
    joined_at: nowIso(ctx),
  };
  ctx.db
    .prepare(
      `INSERT INTO memberships (board_id, principal_id, role, handle, added_by, via_invite_id, access_ends_at, expiry_notified, joined_at)
       VALUES (@board_id, @principal_id, @role, @handle, @added_by, @via_invite_id, @access_ends_at, @expiry_notified, @joined_at)`,
    )
    .run(row);
  return row;
}

export function recordEvent(
  ctx: AppContext,
  emit: (e: HubEvent) => void,
  e: { boardId: string; type: EventType; threadId?: string | null; messageId?: string | null; subjectId?: string | null; actorId?: string | null },
): number {
  const info = ctx.db
    .prepare("INSERT INTO events (board_id, type, thread_id, message_id, subject_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(e.boardId, e.type, e.threadId ?? null, e.messageId ?? null, e.subjectId ?? null, e.actorId ?? null, nowIso(ctx));
  const seq = Number(info.lastInsertRowid);
  const channel = e.threadId ? ((ctx.db.prepare("SELECT channel FROM threads WHERE id = ?").get(e.threadId) as { channel: string } | undefined)?.channel ?? null) : null;
  emit({
    kind: "board",
    boardId: e.boardId,
    seq,
    type: e.type,
    threadId: e.threadId ?? null,
    messageId: e.messageId ?? null,
    actorId: e.actorId ?? null,
    subjectId: e.subjectId ?? null,
    channel,
  });
  return seq;
}

export function activeMemberCount(ctx: AppContext, boardId: string): number {
  return (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE board_id = ? AND (access_ends_at IS NULL OR access_ends_at > ?)").get(boardId, nowIso(ctx)) as {
      n: number;
    }
  ).n;
}

export function assertMemberCapacity(ctx: AppContext, boardId: string): void {
  const used = activeMemberCount(ctx, boardId);
  const limit = boardLimits(ctx, boardId).members_per_board;
  if (used >= limit) {
    throw new OmbError("member_limit_reached", `This board has reached its limit of ${limit} members (including agents)`, {
      allowance: "members",
      used,
      limit,
    });
  }
}

// ---------- boards ----------

export function ownedBoards(ctx: AppContext, principalId: string): BoardRow[] {
  return ctx.db.prepare("SELECT * FROM boards WHERE owner_id = ? AND disabled_at IS NULL ORDER BY is_personal DESC, created_at").all(principalId) as BoardRow[];
}

/**
 * Returns the caller's own board, creating the personal board on first use for people.
 * Concurrent first calls produce one board (unique index on the personal board per owner).
 */
export function ensureOwnBoard(ctx: AppContext, actor: Actor, opts: { create: boolean; name?: string }): BoardRow | null {
  if (actor.kind !== "human") return null;
  const existing = ownedBoards(ctx, actor.id)[0];
  if (existing || !opts.create) return existing ?? null;
  return tx(ctx, (emit) => {
    const again = ownedBoards(ctx, actor.id)[0];
    if (again) return again;
    if (limitsFor(ctx, actor.id).boards_owned < 1) {
      throw new OmbError("quota_exceeded", "Your plan on this server doesn't include owning boards", { allowance: "boards_owned", used: 0, limit: 0 });
    }
    const principal = getPrincipal(ctx, actor.id)!;
    const id = newId("b");
    const name = (opts.name?.trim() || `${principal.display_name}'s board`).slice(0, 80);
    const info = ctx.db
      .prepare("INSERT INTO boards (id, name, owner_id, is_personal, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING")
      .run(id, name, actor.id, nowIso(ctx));
    if (info.changes === 0) return ownedBoards(ctx, actor.id)[0]!;
    insertMembership(ctx, id, principal, "owner");
    recordEvent(ctx, emit, { boardId: id, type: "member.joined", subjectId: actor.id, actorId: actor.id });
    return getBoardRow(ctx, id)!;
  });
}

/**
 * Creates another named board owned by a person, up to their plan's `boards_owned`. Names are unique among the
 * person's boards, ignoring case. The personal board (created on first whoami) stays as it is.
 */
export function createNamedBoard(ctx: AppContext, actor: Actor, rawName: string): Board {
  requireHuman(actor, "Only people can own boards");
  const name = rawName.trim();
  if (!name || name.length > 80) throw invalid("Board name must be 1-80 characters");
  return tx(ctx, (emit) => {
    const owned = ownedBoards(ctx, actor.id);
    const limit = limitsFor(ctx, actor.id).boards_owned;
    if (owned.length >= limit) {
      throw new OmbError("quota_exceeded", `You own ${owned.length} of the ${limit} board(s) your plan allows`, { allowance: "boards_owned", used: owned.length, limit, resets_at: null });
    }
    assertBoardNameFree(owned, name);
    const principal = getPrincipal(ctx, actor.id)!;
    const id = newId("b");
    ctx.db.prepare("INSERT INTO boards (id, name, owner_id, is_personal, created_at) VALUES (?, ?, ?, 0, ?)").run(id, name, actor.id, nowIso(ctx));
    const m = insertMembership(ctx, id, principal, "owner");
    recordEvent(ctx, emit, { boardId: id, type: "member.joined", subjectId: actor.id, actorId: actor.id });
    return presentBoard(ctx, getBoardRow(ctx, id)!, m);
  });
}

function assertBoardNameFree(owned: BoardRow[], name: string, exceptId?: string): void {
  const taken = owned.find((b) => b.id !== exceptId && b.name.trim().toLowerCase() === name.toLowerCase());
  if (taken) throw new OmbError("conflict", `You already have a board named "${taken.name}"`, { reason: "board_name_taken" });
}

/** A board the caller can read: as a member, or through a public grant (11 §Public access). */
export function getBoard(ctx: AppContext, actor: Actor, boardId: string): Board {
  const { board, membership } = requireReader(ctx, actor, boardId);
  return presentBoard(ctx, board, membership);
}

/** The caller's active memberships. A profile has its person's; a scoped token sees only its boards, with its role cap. */
export function listMemberships(ctx: AppContext, actor: Actor): Membership[] {
  const holder = holderId(actor);
  const rows = ctx.db
    .prepare(
      `SELECT m.*, b.name AS board_name, b.owner_id FROM memberships m JOIN boards b ON b.id = m.board_id
       WHERE m.principal_id = ? AND b.disabled_at IS NULL ORDER BY b.created_at`,
    )
    .all(holder) as (MembershipRow & { board_name: string; owner_id: string })[];
  return rows
    .filter((r) => !isExpired(ctx, r) && boardInScope(actor, r.board_id))
    .filter((r) => {
      if (actor.kind !== "agent" || !actor.ownerId || actor.profile) return true;
      const owner = getMembership(ctx, r.board_id, actor.ownerId);
      return !!owner && !isExpired(ctx, owner);
    })
    .map((r) => ({
      board_id: r.board_id,
      board_name: r.board_name,
      board_url: boardUrl(ctx.config.publicUrl, r.board_id),
      role: cappedRole(actor, r.role),
      access_ends_at: r.access_ends_at,
      is_owner: r.owner_id === holder,
    }));
}

export function updateBoard(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  input: { name?: string; settings?: { members_can_add_agents?: boolean; agent_posts_per_day?: number; agent_consecutive_limit?: number } },
): Board {
  return tx(ctx, (emit) => {
    const { board, membership } = requireMember(ctx, actor, boardId, "owner");
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 80) throw invalid("Board name must be 1-80 characters");
      assertBoardNameFree(ownedBoards(ctx, board.owner_id), name, board.id);
      ctx.db.prepare("UPDATE boards SET name = ? WHERE id = ?").run(name, board.id);
    }
    const s = input.settings ?? {};
    if (s.members_can_add_agents !== undefined) ctx.db.prepare("UPDATE boards SET members_can_add_agents = ? WHERE id = ?").run(s.members_can_add_agents ? 1 : 0, board.id);
    if (s.agent_posts_per_day !== undefined) {
      const monthly = boardLimits(ctx, board.id).posts_per_month;
      if (!Number.isInteger(s.agent_posts_per_day) || s.agent_posts_per_day < 0 || s.agent_posts_per_day > monthly) {
        throw invalid(`agent_posts_per_day must be between 0 and ${monthly}`);
      }
      ctx.db.prepare("UPDATE boards SET agent_posts_per_day = ? WHERE id = ?").run(s.agent_posts_per_day, board.id);
    }
    if (s.agent_consecutive_limit !== undefined) {
      if (!Number.isInteger(s.agent_consecutive_limit) || s.agent_consecutive_limit < 1 || s.agent_consecutive_limit > 1000) {
        throw invalid("agent_consecutive_limit must be between 1 and 1000");
      }
      ctx.db.prepare("UPDATE boards SET agent_consecutive_limit = ? WHERE id = ?").run(s.agent_consecutive_limit, board.id);
    }
    recordEvent(ctx, emit, { boardId: board.id, type: "board.updated", actorId: actor.id });
    return presentBoard(ctx, getBoardRow(ctx, board.id)!, membership);
  });
}

export function deleteBoard(ctx: AppContext, actor: Actor, boardId: string, confirmName: string): void {
  const files = tx(ctx, (emit) => {
    const { board } = requireMember(ctx, actor, boardId, "owner");
    if (confirmName.trim() !== board.name) throw invalid("Type the board name exactly to confirm deletion");
    ctx.db.prepare("DELETE FROM events WHERE board_id = ?").run(board.id);
    ctx.db.prepare("DELETE FROM event_subscriptions WHERE board_id = ?").run(board.id);
    const keys = boardAttachmentKeys(ctx, board.id);
    ctx.db.prepare("DELETE FROM boards WHERE id = ?").run(board.id);
    emit({ kind: "board_deleted", boardId: board.id });
    return keys;
  });
  removeFiles(ctx, files);
}

// ---------- members ----------

export function listMembers(ctx: AppContext, actor: Actor, boardId: string): Member[] {
  requireMember(ctx, actor, boardId);
  const rows = ctx.db
    .prepare("SELECT * FROM memberships WHERE board_id = ? AND (access_ends_at IS NULL OR access_ends_at > ?) ORDER BY joined_at")
    .all(boardId, nowIso(ctx)) as MembershipRow[];
  const refs = principalRefs(ctx, rows.map((r) => r.principal_id));
  return rows.map((r) => presentMember(ctx, r, refs));
}

function agentsOf(ctx: AppContext, boardId: string, ownerId: string): MembershipRow[] {
  return ctx.db
    .prepare("SELECT m.* FROM memberships m JOIN principals p ON p.id = m.principal_id WHERE m.board_id = ? AND p.owner_id = ?")
    .all(boardId, ownerId) as MembershipRow[];
}

/** Removes a membership and every agent membership of that principal on the board. Caller holds a transaction. */
export function removeMembershipCascade(
  ctx: AppContext,
  emit: (e: HubEvent) => void,
  boardId: string,
  principalId: string,
  actorId: string | null,
  reason: "removed" | "expired" | "disabled" = "removed",
): void {
  const victims = [principalId, ...agentsOf(ctx, boardId, principalId).map((m) => m.principal_id)];
  for (const id of victims) {
    const info = ctx.db.prepare("DELETE FROM memberships WHERE board_id = ? AND principal_id = ?").run(boardId, id);
    if (info.changes === 0) continue;
    releaseClaimsOf(ctx, emit, boardId, id);
    ctx.db.prepare("DELETE FROM event_subscriptions WHERE board_id = ? AND principal_id = ?").run(boardId, id);
    recordEvent(ctx, emit, { boardId, type: "member.left", subjectId: id, actorId });
    emit({ kind: "access", boardId, principalId: id, reason });
  }
}

export function updateMember(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  principalId: string,
  input: { role?: "reader" | "contributor"; access_ends_at?: string | null },
): Member {
  return tx(ctx, (emit) => {
    const { board } = requireMember(ctx, actor, boardId, "owner");
    if (principalId === board.owner_id) throw invalid("The owner's membership can't be changed");
    const m = getMembership(ctx, boardId, principalId);
    if (!m) throw notFound("Member");
    const target = getPrincipal(ctx, principalId)!;
    if (input.role) {
      if (target.kind === "agent" && target.owner_id) {
        const owner = getMembership(ctx, boardId, target.owner_id);
        if (owner && ROLE_RANK[input.role] > ROLE_RANK[owner.role]) throw invalid("An agent's role can't exceed the role of the person it acts for");
      }
      ctx.db.prepare("UPDATE memberships SET role = ? WHERE board_id = ? AND principal_id = ?").run(input.role, boardId, principalId);
      if (input.role === "reader") {
        ctx.db
          .prepare("UPDATE memberships SET role = 'reader' WHERE board_id = ? AND principal_id IN (SELECT id FROM principals WHERE owner_id = ?)")
          .run(boardId, principalId);
      }
    }
    if (input.access_ends_at !== undefined) {
      const at = input.access_ends_at === null ? null : normalizeTime(input.access_ends_at, "access_ends_at");
      ctx.db.prepare("UPDATE memberships SET access_ends_at = ?, expiry_notified = 0 WHERE board_id = ? AND principal_id = ?").run(at, boardId, principalId);
      if (at !== null && at <= nowIso(ctx)) {
        ctx.db.prepare("UPDATE memberships SET expiry_notified = 1 WHERE board_id = ? AND principal_id = ?").run(boardId, principalId);
        emit({ kind: "access", boardId, principalId, reason: "expired" });
      }
    }
    recordEvent(ctx, emit, { boardId, type: "member.updated", subjectId: principalId, actorId: actor.id });
    emit({ kind: "access", boardId, principalId, reason: "role_changed" });
    return presentMember(ctx, getMembership(ctx, boardId, principalId)!);
  });
}

export function removeMember(ctx: AppContext, actor: Actor, boardId: string, principalId: string): void {
  tx(ctx, (emit) => {
    const board = getBoardRow(ctx, boardId);
    if (!board) throw notFound("Board");
    const self = principalId === actor.id;
    const target = getPrincipal(ctx, principalId);
    const ownsAgent = target?.kind === "agent" && target.owner_id === actor.id;
    if (self || ownsAgent) requireMember(ctx, actor, boardId, "reader");
    else requireMember(ctx, actor, boardId, "owner");
    if (principalId === board.owner_id) throw invalid("The owner can't leave their own board; delete it instead");
    if (!getMembership(ctx, boardId, principalId)) throw notFound("Member");
    removeMembershipCascade(ctx, emit, boardId, principalId, actor.id, "removed");
  });
}

export function normalizeTime(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} must be an RFC 3339 time`);
  return d.toISOString();
}

// ---------- agents ----------

export function createAgent(ctx: AppContext, actor: Actor, displayName: string): Agent {
  requireHuman(actor);
  const name = displayName.trim();
  if (!name || name.length > 60) throw invalid("Agent name must be 1-60 characters");
  const id = newId("p");
  ctx.db
    .prepare("INSERT INTO principals (id, kind, display_name, email, owner_id, created_at) VALUES (?, 'agent', ?, NULL, ?, ?)")
    .run(id, name, actor.id, nowIso(ctx));
  return listAgents(ctx, actor).find((a) => a.id === id)!;
}

export function listAgents(ctx: AppContext, actor: Actor): Agent[] {
  const agents = ctx.db.prepare("SELECT * FROM principals WHERE owner_id = ? AND kind = 'agent' AND profile_name IS NULL ORDER BY created_at").all(actor.id) as PrincipalRow[];
  return agents.map((a) => ({
    id: a.id,
    display_name: a.display_name,
    created_at: a.created_at,
    disabled_at: a.disabled_at,
    boards: (
      ctx.db
        .prepare("SELECT m.board_id, b.name AS board_name, m.role FROM memberships m JOIN boards b ON b.id = m.board_id WHERE m.principal_id = ?")
        .all(a.id) as { board_id: string; board_name: string; role: "reader" | "contributor" }[]
    ).map((r) => ({ board_id: r.board_id, board_name: r.board_name, role: r.role })),
    tokens: (
      ctx.db
        .prepare(
          "SELECT id, prefix, created_at, last_used_at, scope, expires_at FROM api_tokens WHERE principal_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at",
        )
        .all(a.id, nowIso(ctx)) as TokenListRow[]
    ).map(({ scope, ...t }) => ({ ...t, scope: presentScope(scope, t.expires_at) })),
  }));
}

export function requireOwnAgent(ctx: AppContext, actor: Actor, agentId: string): PrincipalRow {
  const agent = getPrincipal(ctx, agentId);
  if (!agent || agent.kind !== "agent" || agent.owner_id !== actor.id || agent.profile_name) throw notFound("Agent");
  return agent;
}

export function disableAgent(ctx: AppContext, actor: Actor, agentId: string): Agent {
  requireHuman(actor);
  tx(ctx, (emit) => {
    const agent = requireOwnAgent(ctx, actor, agentId);
    ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?").run(nowIso(ctx), agent.id);
    ctx.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").run(nowIso(ctx), agent.id);
    for (const m of ctx.db.prepare("SELECT board_id FROM memberships WHERE principal_id = ?").all(agent.id) as { board_id: string }[]) {
      removeMembershipCascade(ctx, emit, m.board_id, agent.id, actor.id, "disabled");
    }
    ctx.db.prepare("DELETE FROM workload_trusts WHERE agent_id = ?").run(agent.id);
  });
  return listAgents(ctx, actor).find((a) => a.id === agentId)!;
}

export function addAgentToBoard(ctx: AppContext, actor: Actor, boardId: string, agentId: string, role: "reader" | "contributor"): Member {
  requireHuman(actor);
  return tx(ctx, (emit) => {
    const { board, membership } = requireMember(ctx, actor, boardId, "reader");
    const agent = requireOwnAgent(ctx, actor, agentId);
    if (agent.disabled_at) throw invalid("This agent is disabled");
    if (membership.role !== "owner" && board.members_can_add_agents !== 1) throw forbidden("The board owner has turned off adding agents");
    const cap = membership.role === "owner" ? "contributor" : membership.role;
    if (ROLE_RANK[role] > ROLE_RANK[cap]) throw invalid(`An agent's role can't exceed yours (${membership.role})`);
    const existing = getMembership(ctx, boardId, agentId);
    if (existing) {
      ctx.db.prepare("UPDATE memberships SET role = ? WHERE board_id = ? AND principal_id = ?").run(role, boardId, agentId);
      recordEvent(ctx, emit, { boardId, type: "member.updated", subjectId: agentId, actorId: actor.id });
      return presentMember(ctx, getMembership(ctx, boardId, agentId)!);
    }
    assertMemberCapacity(ctx, boardId);
    const m = insertMembership(ctx, boardId, agent, role, { addedBy: actor.id, accessEndsAt: membership.access_ends_at });
    recordEvent(ctx, emit, { boardId, type: "member.joined", subjectId: agentId, actorId: actor.id });
    return presentMember(ctx, m);
  });
}

/** Used by workload identity and sync: adds a principal the server manages. Caller holds a transaction. */
export function addManagedMember(
  ctx: AppContext,
  emit: (e: HubEvent) => void,
  boardId: string,
  principal: PrincipalRow,
  role: "reader" | "contributor",
  addedBy: string,
): MembershipRow {
  const existing = getMembership(ctx, boardId, principal.id);
  if (existing) {
    if (existing.role !== role) ctx.db.prepare("UPDATE memberships SET role = ? WHERE board_id = ? AND principal_id = ?").run(role, boardId, principal.id);
    return getMembership(ctx, boardId, principal.id)!;
  }
  assertMemberCapacity(ctx, boardId);
  const m = insertMembership(ctx, boardId, principal, role, { addedBy });
  recordEvent(ctx, emit, { boardId, type: "member.joined", subjectId: principal.id, actorId: addedBy });
  return m;
}

// ---------- tokens ----------

const TOKEN_PREFIX = { agent: "omb_at_", personal: "omb_pt_", test: "omb_tt_" } as const;

/** What a token row stores about its scope; `expires_at` lives in its own column. */
export type StoredScope = { boards: string[] | null; can: TokenPermission[]; profile: string | null };
type TokenListRow = { id: string; prefix: string; created_at: string; last_used_at: string | null; scope: string | null; expires_at: string | null };

export function presentScope(raw: string | null, expiresAt: string | null): TokenScope | null {
  if (!raw) return null;
  const s = JSON.parse(raw) as StoredScope;
  return { boards: s.boards ?? null, can: s.can, profile: s.profile ?? null, expires_at: expiresAt };
}

export function mintToken(
  ctx: AppContext,
  principalId: string,
  kind: keyof typeof TOKEN_PREFIX,
  label?: string,
  opts: { scope?: StoredScope | null; expiresAt?: string | null } = {},
): CreatedToken {
  const raw = TOKEN_PREFIX[kind] + randomToken(32);
  const id = newId("tok");
  const prefix = raw.slice(0, 12);
  const scope = opts.scope ? JSON.stringify(opts.scope) : null;
  const expiresAt = opts.expiresAt ?? null;
  ctx.db
    .prepare("INSERT INTO api_tokens (id, principal_id, kind, token_hash, prefix, label, created_at, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, principalId, kind, sha256(raw), prefix, label ?? null, nowIso(ctx), scope, expiresAt);
  return { id, token: raw, prefix, ...(scope ? { scope: presentScope(scope, expiresAt) } : {}) };
}

export function createAgentToken(ctx: AppContext, actor: Actor, agentId: string, label?: string): CreatedToken {
  requireHuman(actor);
  const agent = requireOwnAgent(ctx, actor, agentId);
  if (agent.disabled_at) throw invalid("This agent is disabled");
  return mintToken(ctx, agent.id, "agent", label);
}

export function revokeAgentToken(ctx: AppContext, actor: Actor, agentId: string, tokenId: string): void {
  requireHuman(actor);
  requireOwnAgent(ctx, actor, agentId);
  const info = ctx.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL").run(nowIso(ctx), tokenId, agentId);
  if (info.changes === 0) throw notFound("Token");
}

export function createPersonalToken(ctx: AppContext, actor: Actor, label?: string): CreatedToken {
  requireHuman(actor, "Agents use agent tokens");
  return mintToken(ctx, actor.id, "personal", label);
}

export function listPersonalTokens(ctx: AppContext, actor: Actor): PersonalToken[] {
  const rows = ctx.db
    .prepare(
      "SELECT id, prefix, label, created_at, last_used_at, scope, expires_at FROM api_tokens WHERE principal_id = ? AND kind = 'personal' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at",
    )
    .all(actor.id, nowIso(ctx)) as (TokenListRow & { label: string | null })[];
  return rows.map(({ scope, ...t }) => ({ ...t, scope: presentScope(scope, t.expires_at) }));
}

export function revokePersonalToken(ctx: AppContext, actor: Actor, tokenId: string): void {
  const info = ctx.db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND principal_id = ? AND kind = 'personal' AND revoked_at IS NULL")
    .run(nowIso(ctx), tokenId, actor.id);
  if (info.changes === 0) throw notFound("Token");
}

/** Resolves an `omb_*` bearer token to its principal and scope. Expired tokens resolve to nothing. */
export function principalForToken(
  ctx: AppContext,
  raw: string,
): { principal: PrincipalRow; kind: "agent" | "personal" | "test"; scope: TokenScope | null } | null {
  if (!raw.startsWith("omb_")) return null;
  const row = ctx.db
    .prepare(
      "SELECT t.id AS token_id, t.kind AS token_kind, t.last_used_at, t.scope AS token_scope, t.expires_at AS token_expires_at, p.* FROM api_tokens t JOIN principals p ON p.id = t.principal_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
    )
    .get(sha256(raw)) as
    | (PrincipalRow & { token_id: string; token_kind: "agent" | "personal" | "test"; last_used_at: string | null; token_scope: string | null; token_expires_at: string | null })
    | undefined;
  if (!row || row.disabled_at) return null;
  if (row.token_expires_at !== null && row.token_expires_at <= nowIso(ctx)) return null;
  if (row.kind === "agent" && row.owner_id) {
    const owner = getPrincipal(ctx, row.owner_id);
    if (!owner || owner.disabled_at) return null;
  }
  const now = nowIso(ctx);
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) {
    ctx.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.token_id);
  }
  const { token_id: _t, token_kind, last_used_at: _l, token_scope, token_expires_at, ...principal } = row;
  return { principal: principal as PrincipalRow, kind: token_kind, scope: presentScope(token_scope, token_expires_at) };
}

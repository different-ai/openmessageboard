import { domainToASCII } from "node:url";
import { inviteTokenFrom, inviteUrl, type Board, type Invite, type InvitePreview } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, invalid, notFound } from "../errors.js";
import { newId, randomToken, sha256 } from "../ids.js";
import { getBoardRow, getMembership, getPrincipal, isExpired, nowIso, requireMember } from "./access.js";
import { assertMemberCapacity, normalizeTime, recordEvent } from "./boards.js";
import type { Actor, InviteRow, MembershipRow } from "./model.js";
import { presentBoard, presentInvite } from "./present.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEEK_MS = 7 * 24 * 3600 * 1000;

export function normalizeDomain(raw: string): string {
  const d = domainToASCII(raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, ""));
  if (!d || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw invalid("Enter a domain such as example.com");
  return d;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : domainToASCII(email.slice(at + 1).toLowerCase());
}

export interface CreateInviteInput {
  audience: "link" | "email" | "domain";
  value?: string | undefined;
  role: "reader" | "contributor";
  join_by?: string | null | undefined;
  access_ends_at?: string | null | undefined;
  max_uses?: number | null | undefined;
}

export function createInvite(ctx: AppContext, actor: Actor, boardId: string, input: CreateInviteInput): Invite {
  const { board } = requireMember(ctx, actor, boardId, "owner");
  let audienceValue: string | null = null;
  if (input.audience === "email") {
    const email = (input.value ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw invalid("Enter the email address this invite is for");
    audienceValue = email;
  } else if (input.audience === "domain") {
    const domain = normalizeDomain(input.value ?? "");
    if (ctx.config.freeMailDomains.has(domain)) throw invalid(`${domain} is a public email provider; domain invites need a company domain`);
    audienceValue = domain;
  } else if (input.value) {
    throw invalid("Link invites don't take a value");
  }
  if (input.role !== "reader" && input.role !== "contributor") throw invalid("Role must be reader or contributor");
  const now = ctx.now();
  let joinBy: string | null;
  if (input.join_by === undefined) joinBy = input.audience === "email" ? null : new Date(now.getTime() + WEEK_MS).toISOString();
  else joinBy = input.join_by === null ? null : normalizeTime(input.join_by, "join_by");
  if (joinBy !== null && joinBy <= now.toISOString()) throw invalid("join_by must be in the future");
  const accessEnds = input.access_ends_at ? normalizeTime(input.access_ends_at, "access_ends_at") : null;
  if (accessEnds !== null && accessEnds <= now.toISOString()) throw invalid("access_ends_at must be in the future");
  let maxUses = input.max_uses ?? null;
  if (input.audience === "email") maxUses = 1;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) throw invalid("max_uses must be a positive integer");
  const token = randomToken(16);
  const row: InviteRow = {
    id: newId("inv"),
    board_id: board.id,
    token_hash: sha256(token),
    created_by: actor.id,
    role: input.role,
    audience: input.audience,
    audience_value: audienceValue,
    join_by: joinBy,
    access_ends_at: accessEnds,
    max_uses: maxUses,
    uses: 0,
    disabled_at: null,
    created_at: now.toISOString(),
  };
  ctx.db
    .prepare(
      `INSERT INTO invites (id, board_id, token_hash, created_by, role, audience, audience_value, join_by, access_ends_at, max_uses, uses, disabled_at, created_at)
       VALUES (@id, @board_id, @token_hash, @created_by, @role, @audience, @audience_value, @join_by, @access_ends_at, @max_uses, @uses, @disabled_at, @created_at)`,
    )
    .run(row);
  return presentInvite(ctx, row, inviteUrl(ctx.config.publicUrl, token));
}

export function listInvites(ctx: AppContext, actor: Actor, boardId: string): Invite[] {
  requireMember(ctx, actor, boardId, "owner");
  const rows = ctx.db.prepare("SELECT * FROM invites WHERE board_id = ? ORDER BY created_at DESC").all(boardId) as InviteRow[];
  return rows.map((r) => presentInvite(ctx, r, null));
}

export function disableInvite(ctx: AppContext, actor: Actor, inviteId: string): Invite {
  const row = ctx.db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId) as InviteRow | undefined;
  if (!row) throw notFound("Invite");
  requireMember(ctx, actor, row.board_id, "owner", "Invite");
  if (!row.disabled_at) ctx.db.prepare("UPDATE invites SET disabled_at = ? WHERE id = ?").run(nowIso(ctx), row.id);
  return presentInvite(ctx, ctx.db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId) as InviteRow, null);
}

function findInvite(ctx: AppContext, tokenOrUrl: string): InviteRow | undefined {
  const token = inviteTokenFrom(tokenOrUrl);
  return ctx.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(token)) as InviteRow | undefined;
}

function inviteStatus(ctx: AppContext, row: InviteRow): InvitePreview["status"] {
  if (row.disabled_at) return "disabled";
  if (row.join_by !== null && row.join_by <= nowIso(ctx)) return "expired";
  if (row.max_uses !== null && row.uses >= row.max_uses) return "used_up";
  return "active";
}

/** What a signed-out holder of the link may see: board name, inviter, role and dates. */
export function previewInvite(ctx: AppContext, tokenOrUrl: string): InvitePreview {
  const row = findInvite(ctx, tokenOrUrl);
  const board = row ? getBoardRow(ctx, row.board_id) : undefined;
  if (!row || !board) throw notFound("Invite");
  const inviter = getPrincipal(ctx, row.created_by);
  return {
    board_name: board.name,
    inviter: inviter?.display_name ?? "The board owner",
    role: row.role,
    audience: row.audience,
    join_by: row.join_by,
    access_ends_at: row.access_ends_at,
    status: inviteStatus(ctx, row),
  };
}

export function redeemInvite(ctx: AppContext, actor: Actor, tokenOrUrl: string): Board {
  ctx.rate.hit(`redeem:${actor.id}`, ctx.config.rateLimits.redemptions_per_hour_principal, 3_600_000);
  return tx(ctx, (emit) => {
    const row = findInvite(ctx, tokenOrUrl);
    const board = row ? getBoardRow(ctx, row.board_id) : undefined;
    if (!row || !board) throw notFound("Invite");
    if (actor.kind !== "human") {
      throw new OmbError("invite_not_eligible", "Agents can't redeem invites; the person an agent acts for adds it to boards", { reason: "agent_not_allowed" });
    }
    const existing = getMembership(ctx, board.id, actor.id);
    if (existing && !isExpired(ctx, existing)) return presentBoard(ctx, board, existing);
    const status = inviteStatus(ctx, row);
    if (status === "disabled") throw new OmbError("invite_disabled", "This invite link has been disabled by the board owner");
    if (status === "expired") throw new OmbError("invite_expired", "This invite link has expired", { reason: "join_by_passed", join_by: row.join_by });
    if (status === "used_up") throw new OmbError("invite_expired", "This invite link has already been used", { reason: "used_up" });
    const email = (actor.email ?? "").toLowerCase();
    if (row.audience === "email" && email !== row.audience_value) {
      throw new OmbError("invite_not_eligible", "This invite is for a different email address", { reason: "email_mismatch" });
    }
    if (row.audience === "domain" && emailDomain(email) !== row.audience_value) {
      throw new OmbError("invite_not_eligible", `This invite is for verified addresses at ${row.audience_value}`, { reason: "domain_mismatch" });
    }
    if (existing) ctx.db.prepare("DELETE FROM memberships WHERE board_id = ? AND principal_id = ?").run(board.id, actor.id);
    assertMemberCapacity(ctx, board.id);
    const principal = getPrincipal(ctx, actor.id)!;
    const handleBase = principal.display_name;
    const handle = (() => {
      const base = handleBase.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "member";
      const taken = new Set((ctx.db.prepare("SELECT handle FROM memberships WHERE board_id = ?").all(board.id) as { handle: string }[]).map((r) => r.handle));
      if (!taken.has(base)) return base;
      for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    })();
    const m: MembershipRow = {
      board_id: board.id,
      principal_id: actor.id,
      role: row.role,
      handle,
      added_by: row.created_by,
      via_invite_id: row.id,
      access_ends_at: row.access_ends_at,
      expiry_notified: 0,
      joined_at: nowIso(ctx),
    };
    ctx.db
      .prepare(
        `INSERT INTO memberships (board_id, principal_id, role, handle, added_by, via_invite_id, access_ends_at, expiry_notified, joined_at)
         VALUES (@board_id, @principal_id, @role, @handle, @added_by, @via_invite_id, @access_ends_at, @expiry_notified, @joined_at)`,
      )
      .run(m);
    ctx.db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(row.id);
    recordEvent(ctx, emit, { boardId: board.id, type: "member.joined", subjectId: actor.id, actorId: actor.id });
    return presentBoard(ctx, board, m);
  });
}

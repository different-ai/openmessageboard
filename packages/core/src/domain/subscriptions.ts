/**
 * Channel subscriptions (spec 03 §Subscriptions): a stored preference, per principal, board and channel pattern,
 * that decides which new activity creates inbox items. A subscription changes what reaches the inbox and nothing
 * about delivery: every delivery path already carries the inbox.
 */
import type { Subscription, SubscriptionLevel } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError } from "../errors.js";
import { boardInScope } from "../auth/scopes.js";
import { nowIso, requireMember } from "./access.js";
import { covers, specificity } from "./grants.js";
import type { Actor } from "./model.js";
import { boardLimits } from "./plans.js";

interface Row {
  principal_id: string;
  board_id: string;
  pattern: string;
  level: SubscriptionLevel;
  created_at: string;
}

const present = (r: Row): Subscription => ({ board_id: r.board_id, pattern: r.pattern, level: r.level, created_at: r.created_at });

/**
 * Creates, replaces or (with `level: null`) removes the caller's subscription at a pattern. Any member may
 * subscribe, to any valid pattern: the answer never says whether a channel exists, and items are only ever created
 * for channels the subscriber can read (conversation.ts).
 */
export function setSubscription(ctx: AppContext, actor: Actor, boardId: string, pattern: string, level: SubscriptionLevel | null): { subscription: Subscription | null } {
  requireMember(ctx, actor, boardId);
  if (level === null) {
    ctx.db.prepare("DELETE FROM subscriptions WHERE principal_id = ? AND board_id = ? AND pattern = ?").run(actor.id, boardId, pattern);
    return { subscription: null };
  }
  const existing = ctx.db.prepare("SELECT * FROM subscriptions WHERE principal_id = ? AND board_id = ? AND pattern = ?").get(actor.id, boardId, pattern) as Row | undefined;
  if (existing) {
    if (existing.level !== level) ctx.db.prepare("UPDATE subscriptions SET level = ? WHERE principal_id = ? AND board_id = ? AND pattern = ?").run(level, actor.id, boardId, pattern);
    return { subscription: present({ ...existing, level }) };
  }
  const limit = boardLimits(ctx, boardId).subscriptions_per_board_principal;
  const used = (ctx.db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE principal_id = ? AND board_id = ?").get(actor.id, boardId) as { n: number }).n;
  if (used >= limit) {
    throw new OmbError("quota_exceeded", `You have ${limit} subscriptions on this board, its limit. Remove one to add another.`, {
      allowance: "subscriptions",
      used,
      limit,
      resets_at: null,
    });
  }
  const row: Row = { principal_id: actor.id, board_id: boardId, pattern, level, created_at: nowIso(ctx) };
  ctx.db.prepare("INSERT INTO subscriptions (principal_id, board_id, pattern, level, created_at) VALUES (?, ?, ?, ?, ?)").run(row.principal_id, row.board_id, row.pattern, row.level, row.created_at);
  return { subscription: present(row) };
}

/** The caller's subscriptions, on one board or on every board it can still reach. */
export function listSubscriptions(ctx: AppContext, actor: Actor, boardId?: string): { subscriptions: Subscription[] } {
  if (boardId !== undefined) requireMember(ctx, actor, boardId);
  const rows = (
    boardId !== undefined
      ? ctx.db.prepare("SELECT * FROM subscriptions WHERE principal_id = ? AND board_id = ? ORDER BY pattern").all(actor.id, boardId)
      : ctx.db.prepare("SELECT * FROM subscriptions WHERE principal_id = ? ORDER BY board_id, pattern").all(actor.id)
  ) as Row[];
  // A scoped token sees only its boards; boards outside it look as if they did not exist.
  return { subscriptions: rows.filter((r) => boardInScope(actor, r.board_id)).map(present) };
}

/**
 * For each principal with a subscription on the board, the level that applies to `channel`: the one at the most
 * specific pattern covering it (the exact channel, then the longest subtree, then `*`), as for grants. Principals
 * with no covering subscription are absent; `mentions`, the default, applies to them.
 */
export function subscriptionLevels(ctx: AppContext, boardId: string, channel: string): Map<string, SubscriptionLevel> {
  const best = new Map<string, { level: SubscriptionLevel; rank: number }>();
  for (const r of ctx.db.prepare("SELECT principal_id, pattern, level FROM subscriptions WHERE board_id = ?").all(boardId) as Pick<Row, "principal_id" | "pattern" | "level">[]) {
    if (!covers(r.pattern, channel)) continue;
    const rank = specificity(r.pattern);
    const seen = best.get(r.principal_id);
    if (!seen || rank > seen.rank) best.set(r.principal_id, { level: r.level, rank });
  }
  return new Map([...best].map(([id, b]) => [id, b.level]));
}

/** The most subscriptions any one principal has on the board, for `get_usage`. */
export function mostSubscriptions(ctx: AppContext, boardId: string): number {
  return (ctx.db.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM subscriptions WHERE board_id = ? GROUP BY principal_id)").get(boardId) as { n: number }).n;
}

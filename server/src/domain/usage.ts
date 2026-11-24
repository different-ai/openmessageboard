import type { AllowanceUsage, Usage } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import { currentMonth, nextMonthStart, nowIso, requireMember } from "./access.js";
import { activeMemberCount } from "./boards.js";
import type { Actor, MessageRow } from "./model.js";
import { presentMessages } from "./present.js";
import { boardLimits, limitsFor, planOf } from "./plans.js";

export function getUsage(ctx: AppContext, actor: Actor, boardId: string): Usage {
  const { board } = requireMember(ctx, actor, boardId, "owner");
  const l = boardLimits(ctx, boardId);
  const ownerLimits = limitsFor(ctx, board.owner_id);
  const posts = (ctx.db.prepare("SELECT posts FROM usage_monthly WHERE board_id = ? AND month = ?").get(boardId, currentMonth(ctx)) as { posts: number } | undefined)?.posts ?? 0;
  const subs = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE board_id = ? AND status = 'active'").get(boardId) as { n: number }).n;
  const owned = (ctx.db.prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ? AND disabled_at IS NULL").get(board.owner_id) as { n: number }).n;
  const item = (allowance: AllowanceUsage["allowance"], used: number, limit: number, unit: "count" | "bytes", resets: string | null): AllowanceUsage => ({
    allowance,
    used,
    limit,
    unit,
    resets_at: resets,
    warning: limit > 0 && used >= 0.8 * limit,
  });
  return {
    board_id: boardId,
    allowances: [
      item("posts", posts, l.posts_per_month, "count", nextMonthStart(ctx)),
      item("storage", board.storage_bytes, l.storage_bytes, "bytes", null),
      item("members", activeMemberCount(ctx, boardId), l.members_per_board, "count", null),
      item("live_connections", ctx.connections.countForBoard(boardId), l.live_connections_per_board, "count", null),
      item("webhook_subscriptions", subs, l.webhook_subscriptions_per_board, "count", null),
      item("boards_owned", owned, ownerLimits.boards_owned, "count", null),
    ],
    plan: planOf(ctx, board.owner_id),
    storage_formula: "UTF-8 bytes of every live message body plus thread titles; deleting a message frees its bytes",
  };
}

/** Full-text search with FTS5. Query terms are quoted, so FTS syntax in input is treated as text. */
export function searchMessages(ctx: AppContext, actor: Actor, boardId: string, query: string, limit = 20) {
  requireMember(ctx, actor, boardId);
  ctx.rate.hit(`r:p:${actor.id}`, ctx.config.rateLimits.reads_per_minute_principal, 60_000);
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) throw invalid("Search needs at least one word");
  const fts = terms.map((t) => `"${t}"`).join(" ");
  const rows = ctx.db
    .prepare(
      `SELECT m.*, t.title AS thread_title, snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snip
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN threads t ON t.id = m.thread_id
       WHERE messages_fts MATCH ? AND m.board_id = ? AND m.deleted_at IS NULL
       ORDER BY rank LIMIT ?`,
    )
    .all(fts, boardId, Math.min(limit, 50)) as (MessageRow & { thread_title: string; snip: string })[];
  const msgs = presentMessages(ctx, rows);
  return { results: rows.map((r, i) => ({ message: msgs[i]!, thread_title: r.thread_title, snippet: r.snip })) };
}

/** Periodic housekeeping: expiry notifications, event retention, idempotency records. */
export function runMaintenance(ctx: AppContext, emitAccess: (boardId: string, principalId: string) => void): { expired: number; purgedEvents: number } {
  const now = nowIso(ctx);
  const expired = ctx.db
    .prepare("SELECT board_id, principal_id FROM memberships WHERE access_ends_at IS NOT NULL AND access_ends_at <= ? AND expiry_notified = 0")
    .all(now) as { board_id: string; principal_id: string }[];
  for (const m of expired) {
    ctx.db.prepare("UPDATE memberships SET expiry_notified = 1 WHERE board_id = ? AND principal_id = ?").run(m.board_id, m.principal_id);
    ctx.db.prepare("UPDATE event_subscriptions SET status = 'terminated', terminated_reason = 'expired', updated_at = ? WHERE board_id = ? AND principal_id = ? AND status = 'active'").run(now, m.board_id, m.principal_id);
    emitAccess(m.board_id, m.principal_id);
    for (const a of ctx.db.prepare("SELECT m.principal_id FROM memberships m JOIN principals p ON p.id = m.principal_id WHERE m.board_id = ? AND p.owner_id = ?").all(m.board_id, m.principal_id) as {
      principal_id: string;
    }[]) {
      emitAccess(m.board_id, a.principal_id);
    }
  }
  const cutoff = new Date(ctx.now().getTime() - ctx.config.limits.event_retention_days * 86_400_000).toISOString();
  const maxOld = (ctx.db.prepare("SELECT MAX(seq) AS s FROM events WHERE created_at < ?").get(cutoff) as { s: number | null }).s;
  let purgedEvents = 0;
  if (maxOld) {
    purgedEvents = ctx.db.prepare("DELETE FROM events WHERE seq <= ?").run(maxOld).changes;
    ctx.db.prepare("UPDATE meta SET value = ? WHERE key = 'events_purged_upto'").run(String(maxOld));
  }
  ctx.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(new Date(ctx.now().getTime() - 86_400_000).toISOString());
  ctx.db.prepare("DELETE FROM agent_daily WHERE day < ?").run(new Date(ctx.now().getTime() - 3 * 86_400_000).toISOString().slice(0, 10));
  ctx.rate.sweep();
  return { expired: expired.length, purgedEvents };
}

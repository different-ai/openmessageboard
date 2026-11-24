/**
 * Scheduled posts: a new thread or a reply that posts later, once or repeating.
 *
 * Each run posts as the schedule's creator through the normal write path (access, role, quotas, burst limits
 * and the agent loop guard are checked at that moment). A creator who lost access, was disabled or is no longer
 * a contributor stops their schedules. Each run carries an idempotency key derived from the schedule and the
 * run number, so a crash between posting and recording the run never posts twice.
 */
import { MAX_TITLE_CHARS, type Schedule, type ScheduleState } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { read, tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { activeMembership, actorFromPrincipal, getPrincipal, nowIso, requireMember, requireThread } from "./access.js";
import { reply, startThread, validateBody, validateLabels } from "./conversation.js";
import type { Actor } from "./model.js";
import { boardLimits } from "./plans.js";
import { principalRefs } from "./present.js";

interface ScheduleRow {
  id: string;
  board_id: string;
  thread_id: string | null;
  created_by: string;
  title: string | null;
  body: string;
  labels: string;
  mentions: string;
  next_run_at: string | null;
  every_seconds: number | null;
  times: number | null;
  until: string | null;
  runs: number;
  last_run_at: string | null;
  last_message_id: string | null;
  last_error: string | null;
  state: ScheduleState;
  stopped_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulePostInput {
  board_id?: string | undefined;
  thread_id?: string | undefined;
  title?: string | undefined;
  body: string;
  labels?: Record<string, string> | undefined;
  mentions?: string[] | undefined;
  in_seconds?: number | undefined;
  at?: string | undefined;
  every_seconds?: number | undefined;
  times?: number | undefined;
  until?: string | undefined;
}

/** The furthest ahead a first run may be. */
const MAX_LEAD_MS = 366 * 86_400_000;
const MAX_TIMES = 100_000;

function presentSchedules(ctx: AppContext, rows: ScheduleRow[]): Schedule[] {
  const mentionIds = rows.map((r) => JSON.parse(r.mentions) as string[]);
  const refs = principalRefs(ctx, [...rows.map((r) => r.created_by), ...mentionIds.flat()]);
  return rows.map((r, i) => ({
    id: r.id,
    board_id: r.board_id,
    thread_id: r.thread_id,
    title: r.title,
    body: r.body,
    labels: JSON.parse(r.labels) as Record<string, string>,
    mentions: mentionIds[i]!.map((id) => refs.get(id)!),
    created_by: refs.get(r.created_by)!,
    created_at: r.created_at,
    state: r.state,
    next_run_at: r.next_run_at,
    every_seconds: r.every_seconds,
    times: r.times,
    until: r.until,
    runs: r.runs,
    last_run_at: r.last_run_at,
    last_message_id: r.last_message_id,
    last_error: r.last_error,
    stopped_reason: r.stopped_reason,
  }));
}

function loadRow(ctx: AppContext, id: string): ScheduleRow | undefined {
  return ctx.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
}

function instant(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(`${field} must be an RFC 3339 time`);
  return ms;
}

export function schedulePost(ctx: AppContext, actor: Actor, input: SchedulePostInput): { schedule: Schedule } {
  if ((input.board_id ? 1 : 0) + (input.thread_id ? 1 : 0) !== 1) throw invalid("Pass board_id (a new thread each run) or thread_id (a reply each run)");
  let boardId: string;
  let threadId: string | null = null;
  if (input.thread_id) {
    const { thread } = requireThread(ctx, actor, input.thread_id, "contributor");
    boardId = thread.board_id;
    threadId = thread.id;
    if (input.title !== undefined) throw invalid("title applies to new threads; leave it out for a reply");
    if (input.labels !== undefined) throw invalid("labels apply to new threads; leave them out for a reply");
  } else {
    requireMember(ctx, actor, input.board_id!, "contributor");
    boardId = input.board_id!;
    if (input.title === undefined || !input.title.trim()) throw invalid("title is required for a new thread");
    if ([...input.title.trim()].length > MAX_TITLE_CHARS) throw invalid(`Titles can be up to ${MAX_TITLE_CHARS} characters`);
  }
  const r = ctx.config.rateLimits;
  ctx.rate.hit(`w:p:${actor.id}`, r.writes_per_minute_principal, 60_000);
  validateBody(ctx, input.body, boardId);
  const labels = validateLabels(input.labels ?? {});
  const mentions = [...new Set(input.mentions ?? [])];
  for (const id of mentions) {
    const p = getPrincipal(ctx, id);
    if (!p || !activeMembership(ctx, boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id, profile: p.profile_name ?? null })) {
      throw invalid(`Mentioned principal ${id} is not a member of this board`, { principal_id: id });
    }
  }

  const now = ctx.now().getTime();
  const limits = boardLimits(ctx, boardId);
  if (input.in_seconds !== undefined && input.at !== undefined) throw invalid("Pass in_seconds or at, not both");
  if (input.every_seconds !== undefined) {
    const min = limits.schedule_min_repeat_seconds;
    if (!Number.isInteger(input.every_seconds) || input.every_seconds < min) {
      throw invalid(`every_seconds must be at least ${min}`, { min_seconds: min });
    }
  } else {
    if (input.times !== undefined && input.times !== 1) throw invalid("times needs every_seconds");
    if (input.until !== undefined) throw invalid("until needs every_seconds");
  }
  let first: number;
  if (input.at !== undefined) first = instant(input.at, "at");
  else if (input.in_seconds !== undefined) first = now + input.in_seconds * 1000;
  else if (input.every_seconds !== undefined) first = now + input.every_seconds * 1000;
  else throw invalid("Pass in_seconds or at (or every_seconds to start one interval from now)");
  if (first <= now) throw invalid("The first run must be in the future");
  if (first > now + MAX_LEAD_MS) throw invalid("The first run can be at most a year away");
  if (input.times !== undefined && (!Number.isInteger(input.times) || input.times < 1 || input.times > MAX_TIMES)) {
    throw invalid(`times must be between 1 and ${MAX_TIMES}`);
  }
  let until: string | null = null;
  if (input.until !== undefined) {
    const u = instant(input.until, "until");
    if (u < first) throw invalid("until is before the first run");
    until = new Date(u).toISOString();
  }
  // A scoped token's authority ends when the token expires; so must every run it schedules.
  const expires = actor.scope?.expires_at ? Date.parse(actor.scope.expires_at) : null;
  if (expires !== null) {
    let last = first;
    if (input.every_seconds !== undefined) {
      const byTimes = input.times !== undefined ? first + (input.times - 1) * input.every_seconds * 1000 : Number.POSITIVE_INFINITY;
      last = Math.min(byTimes, until !== null ? Date.parse(until) : Number.POSITIVE_INFINITY);
    }
    if (last > expires) throw invalid("This token is scoped and expires before the schedule would end; set times or until so every run is before it expires", { expires_at: actor.scope!.expires_at });
  }

  return tx(ctx, () => {
    const pending = (ctx.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE board_id = ? AND state = 'pending'").get(boardId) as { n: number }).n;
    if (pending >= limits.pending_schedules_per_board) {
      throw new OmbError("quota_exceeded", `This board has ${limits.pending_schedules_per_board} pending scheduled posts, its limit. Cancel one to schedule another.`, {
        allowance: "pending_schedules",
        used: pending,
        limit: limits.pending_schedules_per_board,
        resets_at: null,
      });
    }
    const id = newId("sch");
    const at = nowIso(ctx);
    ctx.db
      .prepare(
        `INSERT INTO schedules (id, board_id, thread_id, created_by, title, body, labels, mentions, next_run_at, every_seconds, times, until, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        boardId,
        threadId,
        actor.id,
        input.title?.trim() ?? null,
        input.body,
        JSON.stringify(labels),
        JSON.stringify(mentions),
        new Date(first).toISOString(),
        input.every_seconds ?? null,
        input.times ?? (input.every_seconds === undefined ? 1 : null),
        until,
        at,
        at,
      );
    return { schedule: presentSchedules(ctx, [loadRow(ctx, id)!])[0]! };
  });
}

export function listSchedules(
  ctx: AppContext,
  actor: Actor,
  input: { board_id?: string | undefined; thread_id?: string | undefined; all?: boolean | undefined; limit?: number | undefined },
): { schedules: Schedule[] } {
  if ((input.board_id ? 1 : 0) + (input.thread_id ? 1 : 0) !== 1) throw invalid("Pass board_id or thread_id");
  return read(ctx, () => {
    const params: unknown[] = [];
    let sql = "SELECT * FROM schedules WHERE ";
    if (input.thread_id) {
      requireThread(ctx, actor, input.thread_id);
      sql += "thread_id = ?";
      params.push(input.thread_id);
    } else {
      requireMember(ctx, actor, input.board_id!);
      sql += "board_id = ?";
      params.push(input.board_id);
    }
    sql += input.all ? " ORDER BY created_at DESC, id DESC" : " AND state = 'pending' ORDER BY next_run_at, id";
    sql += " LIMIT ?";
    params.push(Math.min(Math.max(input.limit ?? 100, 1), 500));
    return { schedules: presentSchedules(ctx, ctx.db.prepare(sql).all(...params) as ScheduleRow[]) };
  });
}

export function cancelSchedule(ctx: AppContext, actor: Actor, scheduleId: string): { schedule: Schedule; cancelled: boolean } {
  return tx(ctx, () => {
    const row = loadRow(ctx, scheduleId);
    if (!row) throw notFound("Schedule");
    const { membership } = requireMember(ctx, actor, row.board_id, "reader", "Schedule");
    const ownsCreator = getPrincipal(ctx, row.created_by)?.owner_id === actor.id;
    // A profile cancels only what it scheduled, whatever its person's role (like deleting messages).
    const allowed = actor.profile ? row.created_by === actor.id : row.created_by === actor.id || membership.role === "owner" || ownsCreator;
    if (!allowed) {
      throw forbidden("A scheduled post can be cancelled by its creator or the board owner");
    }
    if (row.state !== "pending") return { schedule: presentSchedules(ctx, [row])[0]!, cancelled: false };
    const now = nowIso(ctx);
    ctx.db.prepare("UPDATE schedules SET state = 'cancelled', next_run_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id);
    return { schedule: presentSchedules(ctx, [loadRow(ctx, row.id)!])[0]!, cancelled: true };
  });
}

/** Stops the pending schedules a principal created on a board (their access ended). */
export function stopSchedulesFor(ctx: AppContext, boardId: string, principalId: string, reason: string): number {
  return ctx.db
    .prepare("UPDATE schedules SET state = 'stopped', stopped_reason = ?, next_run_at = NULL, updated_at = ? WHERE board_id = ? AND created_by = ? AND state = 'pending'")
    .run(reason, nowIso(ctx), boardId, principalId).changes;
}

function stop(ctx: AppContext, row: ScheduleRow, reason: string, error: string | null = null): void {
  ctx.db
    .prepare("UPDATE schedules SET state = 'stopped', stopped_reason = ?, last_error = COALESCE(?, last_error), next_run_at = NULL, updated_at = ? WHERE id = ? AND state = 'pending'")
    .run(reason, error, nowIso(ctx), row.id);
}

/** The next run after the one that just came due, skipping runs missed while the server was down. */
function nextRun(row: ScheduleRow, runs: number, nowMs: number): string | null {
  if (!row.every_seconds || !row.next_run_at) return null;
  if (row.times !== null && runs >= row.times) return null;
  const step = row.every_seconds * 1000;
  let next = Date.parse(row.next_run_at) + step;
  if (next <= nowMs) next += Math.ceil((nowMs - next + 1) / step) * step;
  if (row.until !== null && next > Date.parse(row.until)) return null;
  return new Date(next).toISOString();
}

/** Errors that mean the creator can no longer post here: the schedule stops. */
const STOPPING: Record<string, string> = { not_found: "access_ended", access_ended: "access_ended", forbidden: "not_a_contributor" };

/** Fires one due schedule. Returns what happened, for tests and logs. */
export function fireSchedule(ctx: AppContext, row: ScheduleRow): "posted" | "skipped" | "stopped" | "retry" {
  const principal = getPrincipal(ctx, row.created_by);
  const owner = principal?.owner_id ? getPrincipal(ctx, principal.owner_id) : undefined;
  if (!principal || principal.disabled_at || owner?.disabled_at) {
    stop(ctx, row, "principal_disabled");
    return "stopped";
  }
  const actor = actorFromPrincipal(principal, "system");
  const run = row.runs + 1;
  const key = `sch:${row.id}:${run}`;
  // A mention of someone who has since left is dropped rather than failing the whole post.
  const mentions = (JSON.parse(row.mentions) as string[]).filter((id) => {
    const p = getPrincipal(ctx, id);
    return !!p && !!activeMembership(ctx, row.board_id, { id: p.id, kind: p.kind, ownerId: p.owner_id, profile: p.profile_name ?? null });
  });
  let messageId: string | null = null;
  let error: string | null = null;
  try {
    if (row.thread_id) {
      messageId = reply(ctx, actor, row.thread_id, { body: row.body, ...(mentions.length ? { mentions } : {}), idempotency_key: key }).message.id;
    } else {
      const labels = JSON.parse(row.labels) as Record<string, string>;
      messageId = startThread(ctx, actor, row.board_id, {
        title: row.title ?? "Scheduled post",
        body: row.body,
        ...(Object.keys(labels).length ? { labels } : {}),
        ...(mentions.length ? { mentions } : {}),
        idempotency_key: key,
      }).message.id;
    }
  } catch (e) {
    const code = e instanceof OmbError ? e.code : "internal";
    if (code === "internal") console.error("scheduled post failed", e);
    if (STOPPING[code]) {
      stop(ctx, row, STOPPING[code]!, code);
      return "stopped";
    }
    // Burst limits pass quickly: try again on a later tick.
    if (code === "rate_limited") {
      ctx.db.prepare("UPDATE schedules SET last_error = ?, updated_at = ? WHERE id = ?").run(code, nowIso(ctx), row.id);
      return "retry";
    }
    // An earlier attempt of this run already posted (with other mentions): count the run as done.
    if (code !== "idempotency_conflict") error = code;
  }
  const next = nextRun(row, run, ctx.now().getTime());
  ctx.db
    .prepare(
      `UPDATE schedules SET runs = ?, last_run_at = ?, last_message_id = COALESCE(?, last_message_id), last_error = ?, next_run_at = ?, state = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
    )
    .run(run, nowIso(ctx), messageId, error, next, next ? "pending" : "done", nowIso(ctx), row.id);
  return error ? "skipped" : "posted";
}

/** Fires every schedule that is due. Called by the runner; tests call it with a controlled clock. */
export function runDueSchedules(ctx: AppContext, max = 200): number {
  const due = ctx.db.prepare("SELECT * FROM schedules WHERE state = 'pending' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?").all(nowIso(ctx), max) as ScheduleRow[];
  let fired = 0;
  for (const row of due) {
    // Re-read: an earlier run in this batch may have stopped it (same creator lost access).
    const current = loadRow(ctx, row.id);
    if (!current || current.state !== "pending" || !current.next_run_at || current.next_run_at > nowIso(ctx)) continue;
    if (fireSchedule(ctx, current) !== "retry") fired++;
  }
  return fired;
}

/** Starts the runner and stops schedules as soon as their creator loses access. Returns a stop function. */
export function startSchedules(ctx: AppContext): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      runDueSchedules(ctx);
    } catch (e) {
      console.error("schedule runner failed", e);
    } finally {
      running = false;
    }
  }, ctx.config.scheduleTickMs);
  timer.unref();
  const unsub = ctx.hub.subscribe((e) => {
    if (e.kind === "access" && e.reason !== "role_changed") stopSchedulesFor(ctx, e.boardId, e.principalId, e.reason === "disabled" ? "principal_disabled" : "access_ended");
  });
  return () => {
    clearInterval(timer);
    unsub();
  };
}

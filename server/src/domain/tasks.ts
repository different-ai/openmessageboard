/**
 * Tasks (spec/v0.1/04): states, claim leases, dependencies, tasks kept for one principal, plans and claim-next.
 *
 * Every write runs in one transaction with its `thread.updated` change. A claim is a lease fenced by a token: the
 * claimer's own identity plus the current token are needed to renew, complete, fail, release or block, so a worker
 * whose lease ran out cannot settle a task someone else has since claimed.
 */
import {
  FINISHED_TASK_STATES,
  MAX_PLAN_TASKS,
  MAX_TASK_NEEDS,
  MAX_TASK_REASON_CHARS,
  OPEN_TASK_STATES,
  ROLE_RANK,
  TASK_BLOCK_KIND_PATTERN,
  TASK_STATE_FILTERS,
  TASK_STATE_LABEL,
  WAIT_MAX_SECONDS,
  type AllowanceUsage,
  type Labels,
  type Message,
  type TaskAction,
  type TaskClaim,
  type TaskState,
  type Thread,
  type ThreadKind,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import { newId, randomToken } from "../ids.js";
import type { HubEvent } from "../live/hub.js";
import { activeMembership, getPrincipal, nowIso, requireMember, requireThread } from "./access.js";
import { recordEvent } from "./boards.js";
import {
  addInboxItem,
  checkWriteRate,
  follow,
  idempotent,
  insertThread,
  labelClauses,
  loadThread,
  rejectReservedLabels,
  replyInTx,
  usageWarnings,
  validateBody,
  validateLabels,
  validateTitle,
} from "./conversation.js";
import type { Actor, BoardRow, MembershipRow, ThreadRow } from "./model.js";
import { presentThread, presentThreads, refOf } from "./present.js";
import { boardLimits } from "./plans.js";

type Emit = (e: HubEvent) => void;

const FINISHED = new Set<TaskState>(FINISHED_TASK_STATES);
const OPEN_LIST = OPEN_TASK_STATES.map((s) => `'${s}'`).join(", ");

/** Task fields a new thread is stored with. */
export interface NewTask {
  state: TaskState;
  forId: string | null;
  needs: string[];
}

// ---------- filters ----------

/**
 * SQL for a task-state filter on `threads t`: `board.task=<state>` in a label filter, or `task_state`. `open` matches
 * every unfinished state. Returns null for any other label key.
 */
export function taskStateClause(key: string, value: string, params: unknown[]): string | null {
  if (key !== TASK_STATE_LABEL) return null;
  if (!(TASK_STATE_FILTERS as readonly string[]).includes(value)) {
    throw invalid(`${TASK_STATE_LABEL} must be one of ${TASK_STATE_FILTERS.join(", ")}`, { label: key, value });
  }
  if (value === "open") return ` AND t.task_state IN (${OPEN_LIST})`;
  params.push(value);
  return " AND t.task_state = ?";
}

/** Whether a presented thread matches a label filter, with `board.task` read from the task state. */
export function labelsMatch(thread: Thread, labels: Labels): boolean {
  return Object.entries(labels).every(([k, v]) => {
    if (k !== TASK_STATE_LABEL) return thread.labels[k] === v;
    const state = thread.task?.state;
    if (!state) return false;
    return v === "open" ? (OPEN_TASK_STATES as readonly string[]).includes(state) : state === v;
  });
}

// ---------- shared checks ----------

function requireTask(thread: ThreadRow): asserts thread is ThreadRow & { task_state: TaskState } {
  if (thread.kind !== "task" || !thread.task_state) throw new OmbError("task_not_claimable", "This thread is not a task", { state: null });
}

/** The task's owner (its creator, or the person an agent creator acts for) or the board owner. */
function isTaskOwner(ctx: AppContext, actor: Actor, thread: ThreadRow, membership: MembershipRow): boolean {
  if (membership.role === "owner" || thread.created_by === actor.id) return true;
  return getPrincipal(ctx, thread.created_by)?.owner_id === actor.id;
}

function requireTaskOwner(ctx: AppContext, actor: Actor, thread: ThreadRow, membership: MembershipRow, action: string): void {
  if (!isTaskOwner(ctx, actor, thread, membership)) {
    throw new OmbError("task_not_owned", `Only the task's owner or the board owner can ${action} this task`, { owner: refOf(ctx, thread.created_by) });
  }
}

function finishedError(thread: ThreadRow): OmbError {
  return new OmbError("task_finished", `This task is ${thread.task_state}`, { state: thread.task_state });
}

function conflict(thread: ThreadRow, action: string): OmbError {
  return new OmbError("conflict", `Can't ${action} a ${thread.task_state} task`, { state: thread.task_state, action });
}

/** Resolves `for`: a member or agent of the board who can claim (contributor or owner). */
function resolveClaimant(ctx: AppContext, actor: Actor, boardId: string, value: string): string {
  const id = value === "me" ? actor.id : value;
  const p = getPrincipal(ctx, id);
  const m = p ? activeMembership(ctx, boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id }) : undefined;
  if (!p || !m || p.disabled_at) throw invalid(`Principal ${id} is not a member of this board`, { principal_id: id });
  if (p.kind === "integration") throw invalid("Tasks can't be kept for an integration", { principal_id: id });
  if (ROLE_RANK[m.role] < ROLE_RANK.contributor) throw invalid(`Principal ${id} is a reader and can't claim tasks`, { principal_id: id });
  return id;
}

function validateReason(reason: string | undefined, action: string): string {
  const r = reason?.trim();
  if (!r) throw invalid(`${action} needs a reason`);
  if ([...r].length > MAX_TASK_REASON_CHARS) throw invalid(`Reasons can be up to ${MAX_TASK_REASON_CHARS} characters`);
  return r;
}

/** Prerequisites still unmet among existing task IDs. */
function pendingAmong(ctx: AppContext, ids: string[]): boolean {
  if (ids.length === 0) return false;
  return !!ctx.db.prepare(`SELECT 1 FROM threads WHERE id IN (${ids.map(() => "?").join(",")}) AND task_state != 'completed' LIMIT 1`).get(...ids);
}

function needsPending(ctx: AppContext, taskId: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM task_needs n JOIN threads p ON p.id = n.needs_id WHERE n.task_id = ? AND p.task_state != 'completed' LIMIT 1")
    .get(taskId);
}

/** `waiting` while any prerequisite is unmet, else `ready`. */
function unclaimedState(ctx: AppContext, taskId: string): "waiting" | "ready" {
  return needsPending(ctx, taskId) ? "waiting" : "ready";
}

/** Validates prerequisites: existing tasks on the same board, no self reference, no cycle through `selfId`. */
function validateNeeds(ctx: AppContext, boardId: string, ids: string[], selfId: string | null): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TASK_NEEDS) throw new OmbError("invalid_needs", `A task can wait for up to ${MAX_TASK_NEEDS} tasks`, { limit: MAX_TASK_NEEDS });
  for (const id of unique) {
    if (id === selfId) throw new OmbError("invalid_needs", "A task can't wait for itself", { thread_id: id });
    const row = ctx.db.prepare("SELECT board_id, kind FROM threads WHERE id = ?").get(id) as { board_id: string; kind: ThreadKind } | undefined;
    if (!row || row.board_id !== boardId || row.kind !== "task") {
      throw new OmbError("invalid_needs", `${id} is not a task on this board`, { thread_id: id });
    }
  }
  if (selfId) {
    // A cycle exists when the task is reachable from one of its new prerequisites.
    const seen = new Set<string>();
    const stack = [...unique];
    const next = ctx.db.prepare("SELECT needs_id FROM task_needs WHERE task_id = ?");
    while (stack.length) {
      const id = stack.pop()!;
      if (id === selfId) throw new OmbError("invalid_needs", "These needs would make tasks wait for each other", { thread_id: selfId });
      if (seen.has(id)) continue;
      seen.add(id);
      for (const r of next.all(id) as { needs_id: string }[]) stack.push(r.needs_id);
    }
  }
  return unique;
}

function insertNeeds(ctx: AppContext, taskId: string, needs: string[]): void {
  const stmt = ctx.db.prepare("INSERT OR IGNORE INTO task_needs (task_id, needs_id) VALUES (?, ?)");
  for (const n of needs) stmt.run(taskId, n);
}

function changed(ctx: AppContext, emit: Emit, thread: ThreadRow, actorId: string | null): void {
  recordEvent(ctx, emit, { boardId: thread.board_id, type: "thread.updated", threadId: thread.id, actorId });
}

// ---------- creation ----------

/** Validates the task fields of `start_thread`. Caller holds a transaction. */
export function prepareTask(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  kind: ThreadKind,
  input: { needs?: string[] | undefined; for?: string | undefined; claim?: boolean | undefined },
): NewTask | null {
  if (kind !== "task") {
    if (input.needs !== undefined || input.for !== undefined || input.claim) throw invalid("needs, for and claim only apply to tasks");
    return null;
  }
  const forId = input.for !== undefined ? resolveClaimant(ctx, actor, boardId, input.for) : null;
  const needs = validateNeeds(ctx, boardId, input.needs ?? [], null);
  return { state: pendingAmong(ctx, needs) ? "waiting" : "ready", forId, needs };
}

/** After a task's thread and root message exist: its needs, the task_assigned item, and an optional claim. */
export function finishTaskCreation(
  ctx: AppContext,
  emit: Emit,
  actor: Actor,
  board: BoardRow,
  threadId: string,
  rootMessageId: string,
  task: NewTask,
  claim: boolean,
): TaskClaim | undefined {
  insertNeeds(ctx, threadId, task.needs);
  if (task.forId && task.forId !== actor.id) addInboxItem(ctx, emit, { principalId: task.forId, kind: "task_assigned", boardId: board.id, threadId, messageId: rootMessageId });
  if (!claim) return undefined;
  const thread = loadThread(ctx, threadId);
  assertClaimable(ctx, actor, thread);
  return claimRow(ctx, emit, actor, thread, undefined);
}

type PlanNeed = string | { key: string };
export interface PlanTask {
  key?: string | undefined;
  title: string;
  body: string;
  labels?: Record<string, string> | undefined;
  needs?: PlanNeed[] | undefined;
  for?: string | undefined;
}

/** `create_tasks`: up to 15 tasks in one transaction, with needs by key inside the plan. */
export function createTasks(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  input: { tasks: PlanTask[]; idempotency_key?: string | undefined },
): { threads: Thread[]; usage_warning?: AllowanceUsage[] } {
  checkWriteRate(ctx, actor, boardId, {});
  const result = tx(ctx, (emit) => {
    const { board } = requireMember(ctx, actor, boardId, "contributor");
    const { idempotency_key: key, ...payload } = input;
    return idempotent(ctx, actor, key, { op: "create_tasks", boardId, ...payload }, () => {
      const tasks = input.tasks;
      if (tasks.length === 0 || tasks.length > MAX_PLAN_TASKS) throw invalid(`A plan has 1-${MAX_PLAN_TASKS} tasks`);
      const byKey = new Map<string, number>();
      tasks.forEach((t, i) => {
        if (t.key === undefined) return;
        if (byKey.has(t.key)) throw new OmbError("invalid_needs", `Two tasks share the key "${t.key}"`, { key: t.key });
        byKey.set(t.key, i);
      });
      const ids = tasks.map(() => newId("t"));
      const internal: number[][] = [];
      const external: string[][] = [];
      tasks.forEach((t, i) => {
        const inPlan: number[] = [];
        const existing: string[] = [];
        for (const n of t.needs ?? []) {
          if (typeof n === "string") existing.push(n);
          else {
            const j = byKey.get(n.key);
            if (j === undefined) throw new OmbError("invalid_needs", `No task in this plan has the key "${n.key}"`, { key: n.key });
            if (j === i) throw new OmbError("invalid_needs", "A task can't wait for itself", { key: n.key });
            inPlan.push(j);
          }
        }
        internal.push([...new Set(inPlan)]);
        external.push(validateNeeds(ctx, board.id, existing, null));
        if (internal[i]!.length + external[i]!.length > MAX_TASK_NEEDS) {
          throw new OmbError("invalid_needs", `A task can wait for up to ${MAX_TASK_NEEDS} tasks`, { limit: MAX_TASK_NEEDS });
        }
      });
      // Plan-internal needs must not form a cycle (existing tasks can't need the new ones).
      const state = new Array<number>(tasks.length).fill(0);
      const visit = (i: number): void => {
        if (state[i] === 2) return;
        if (state[i] === 1) throw new OmbError("invalid_needs", "Tasks in this plan wait for each other", { key: tasks[i]!.key ?? null });
        state[i] = 1;
        for (const j of internal[i]!) visit(j);
        state[i] = 2;
      };
      tasks.forEach((_, i) => visit(i));
      const prepared = tasks.map((t, i) => {
        const title = validateTitle(t.title);
        const bytes = validateBody(ctx, t.body, board.id);
        const labels = validateLabels(t.labels ?? {});
        rejectReservedLabels(Object.keys(labels));
        const forId = t.for !== undefined ? resolveClaimant(ctx, actor, board.id, t.for) : null;
        const waiting = internal[i]!.length > 0 || pendingAmong(ctx, external[i]!);
        return { title, bytes, labels, forId, waiting };
      });
      const roots: string[] = [];
      prepared.forEach((p, i) => {
        const { message } = insertThread(ctx, emit, actor, board, {
          id: ids[i]!,
          title: p.title,
          body: tasks[i]!.body,
          bytes: p.bytes,
          labels: p.labels,
          mentions: [],
          kind: "task",
          task: { state: p.waiting ? "waiting" : "ready", forId: p.forId, needs: [] },
        });
        roots.push(message.id);
      });
      prepared.forEach((p, i) => {
        insertNeeds(ctx, ids[i]!, [...internal[i]!.map((j) => ids[j]!), ...external[i]!]);
        if (p.forId && p.forId !== actor.id) addInboxItem(ctx, emit, { principalId: p.forId, kind: "task_assigned", boardId: board.id, threadId: ids[i]!, messageId: roots[i]! });
      });
      const rows = ids.map((id) => loadThread(ctx, id));
      return { threads: presentThreads(ctx, rows, actor.id) };
    });
  });
  const warn = usageWarnings(ctx, boardId);
  return { ...result, ...(warn ? { usage_warning: warn } : {}) };
}

// ---------- leases ----------

function leaseMs(ctx: AppContext, boardId: string, requested: number | undefined): number {
  const max = Math.max(1, boardLimits(ctx, boardId).task_lease_seconds);
  const seconds = requested === undefined ? max : Math.min(Math.max(1, Math.floor(requested)), max);
  return seconds * 1000;
}

/** The caller's current claim (only for a live lease, which always has a token and an end). */
function claimOf(thread: ThreadRow): TaskClaim {
  return { epoch: thread.task_claim_epoch, token: thread.task_claim_token!, until: thread.task_lease_until! };
}

function leaseLive(ctx: AppContext, thread: ThreadRow): boolean {
  return thread.task_state === "claimed" && !!thread.task_lease_until && thread.task_lease_until > nowIso(ctx);
}

/** Returns claimed tasks whose lease ran out to `ready` (or `waiting`), one change each. Caller holds a transaction. */
function expireLeasesInTx(ctx: AppContext, emit: Emit, scope: { boardId?: string; threadId?: string }): number {
  const now = nowIso(ctx);
  const params: unknown[] = [now];
  let sql = "SELECT * FROM threads WHERE task_state = 'claimed' AND task_lease_until <= ?";
  if (scope.boardId) {
    sql += " AND board_id = ?";
    params.push(scope.boardId);
  }
  if (scope.threadId) {
    sql += " AND id = ?";
    params.push(scope.threadId);
  }
  const rows = ctx.db.prepare(sql + " LIMIT 500").all(...params) as ThreadRow[];
  for (const t of rows) {
    const info = ctx.db
      .prepare(
        `UPDATE threads SET task_state = ?, task_assignee_id = NULL, task_claimed_at = NULL, task_lease_until = NULL, task_claim_token = NULL, last_activity_at = ?
         WHERE id = ? AND task_state = 'claimed' AND task_lease_until <= ?`,
      )
      .run(unclaimedState(ctx, t.id), now, t.id, now);
    if (info.changes) changed(ctx, emit, t, null);
  }
  return rows.length;
}

/** Expires every lease that ran out (the maintenance loop). */
export function expireTaskLeases(ctx: AppContext, scope: { boardId?: string; threadId?: string } = {}): number {
  return tx(ctx, (emit) => expireLeasesInTx(ctx, emit, scope));
}

/** Ends the claims a principal holds on a board (their membership ended). Caller holds a transaction. */
export function releaseClaimsOf(ctx: AppContext, emit: Emit, boardId: string, principalId: string): void {
  const rows = ctx.db.prepare("SELECT * FROM threads WHERE board_id = ? AND task_state = 'claimed' AND task_assignee_id = ?").all(boardId, principalId) as ThreadRow[];
  const now = nowIso(ctx);
  for (const t of rows) {
    ctx.db
      .prepare(
        "UPDATE threads SET task_state = ?, task_assignee_id = NULL, task_claimed_at = NULL, task_lease_until = NULL, task_claim_token = NULL, last_activity_at = ? WHERE id = ?",
      )
      .run(unclaimedState(ctx, t.id), now, t.id);
    changed(ctx, emit, t, null);
  }
}

// ---------- claiming ----------

/** Throws the error for a task the caller can't claim now. Returns "held" when the caller already holds a live claim. */
function assertClaimable(ctx: AppContext, actor: Actor, thread: ThreadRow): "ready" | "held" {
  requireTask(thread);
  switch (thread.task_state) {
    case "ready":
      if (thread.task_for_id && thread.task_for_id !== actor.id) {
        throw new OmbError("task_assigned", "This task is kept for someone else", { for: refOf(ctx, thread.task_for_id) });
      }
      return "ready";
    case "claimed":
      if (thread.task_assignee_id === actor.id && leaseLive(ctx, thread)) return "held";
      throw new OmbError("task_already_claimed", "Someone else has claimed this task", {
        assignee: thread.task_assignee_id ? refOf(ctx, thread.task_assignee_id) : null,
        lease_until: thread.task_lease_until,
      });
    case "waiting":
      throw new OmbError("task_waiting", "This task waits for tasks that haven't completed", { state: "waiting" });
    case "blocked":
      throw new OmbError("task_blocked", "This task is held for a person", { state: "blocked", reason: thread.task_reason, kind: thread.task_blocked_kind });
    default:
      throw finishedError(thread);
  }
}

/** Claims a ready task: a new epoch, token and lease. Caller holds a transaction and checked `assertClaimable`. */
function claimRow(ctx: AppContext, emit: Emit, actor: Actor, thread: ThreadRow, leaseSeconds: number | undefined): TaskClaim {
  const now = nowIso(ctx);
  const until = new Date(ctx.now().getTime() + leaseMs(ctx, thread.board_id, leaseSeconds)).toISOString();
  const epoch = thread.task_claim_epoch + 1;
  const token = randomToken(24);
  const info = ctx.db
    .prepare(
      `UPDATE threads SET task_state = 'claimed', task_assignee_id = ?, task_claimed_at = ?, task_lease_until = ?, task_claim_epoch = ?, task_claim_token = ?, last_activity_at = ?
       WHERE id = ? AND task_state = 'ready'`,
    )
    .run(actor.id, now, until, epoch, token, now, thread.id);
  if (info.changes === 0) {
    const winner = loadThread(ctx, thread.id).task_assignee_id;
    throw new OmbError("task_already_claimed", "Someone else claimed this task first", { assignee: winner ? refOf(ctx, winner) : null });
  }
  follow(ctx, actor.id, thread.id);
  changed(ctx, emit, thread, actor.id);
  return { epoch, token, until };
}

export interface ClaimTaskInput {
  thread_id?: string | undefined;
  board_id?: string | undefined;
  labels?: Record<string, string> | undefined;
  wait_seconds?: number | undefined;
  lease_seconds?: number | undefined;
}

function claimOnce(ctx: AppContext, actor: Actor, input: ClaimTaskInput): { thread: Thread; claim: TaskClaim } {
  if (input.thread_id) {
    const threadId = input.thread_id;
    expireTaskLeases(ctx, { threadId });
    return tx(ctx, (emit) => {
      const { thread } = requireThread(ctx, actor, threadId, "contributor");
      if (assertClaimable(ctx, actor, thread) === "held") return { thread: presentThread(ctx, thread, actor.id), claim: claimOf(thread) };
      const claim = claimRow(ctx, emit, actor, thread, input.lease_seconds);
      return { thread: presentThread(ctx, loadThread(ctx, thread.id), actor.id), claim };
    });
  }
  const boardId = input.board_id!;
  requireMember(ctx, actor, boardId, "contributor");
  expireTaskLeases(ctx, { boardId });
  return tx(ctx, (emit) => {
    requireMember(ctx, actor, boardId, "contributor");
    const params: unknown[] = [boardId, actor.id];
    // Tasks kept for the caller first, then unassigned ones; oldest first within each.
    const sql =
      "SELECT t.* FROM threads t WHERE t.board_id = ? AND t.kind = 'task' AND t.task_state = 'ready' AND (t.task_for_id IS NULL OR t.task_for_id = ?)" +
      labelClauses(input.labels, params) +
      " ORDER BY (t.task_for_id IS NULL), t.created_at, t.id LIMIT 1";
    const next = ctx.db.prepare(sql).get(...params) as ThreadRow | undefined;
    if (!next) throw new OmbError("no_task_available", "No ready task matches");
    const claim = claimRow(ctx, emit, actor, next, input.lease_seconds);
    return { thread: presentThread(ctx, loadThread(ctx, next.id), actor.id), claim };
  });
}

/**
 * `claim_task`: one task by ID, or the oldest ready task on a board. With `wait_seconds`, a claim-next waits for a
 * matching task to become ready (a new task, a completed prerequisite, a release, or a lease running out).
 */
export async function claimTask(ctx: AppContext, actor: Actor, input: ClaimTaskInput, signal?: AbortSignal): Promise<{ thread: Thread; claim: TaskClaim }> {
  if ((input.thread_id ? 1 : 0) + (input.board_id ? 1 : 0) !== 1) throw invalid("Pass exactly one of thread_id or board_id");
  if (input.labels && !input.board_id) throw invalid("labels only apply with board_id");
  if (input.wait_seconds !== undefined && !input.board_id) throw invalid("wait_seconds only applies with board_id");
  const waitMs = Math.min(Math.max(input.wait_seconds ?? 0, 0), WAIT_MAX_SECONDS) * 1000;
  try {
    return claimOnce(ctx, actor, input);
  } catch (e) {
    if (!(e instanceof OmbError && e.code === "no_task_available") || waitMs === 0) throw e;
  }
  const boardId = input.board_id!;
  const deadline = Date.now() + waitMs;
  let wake: () => void = () => {};
  const conn = ctx.connections.register({ principalId: actor.id, kind: "wait", boards: new Set([boardId]), close: () => wake() });
  let closed = false;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted || closed) break;
      const nextLease = (ctx.db.prepare("SELECT MIN(task_lease_until) AS u FROM threads WHERE board_id = ? AND task_state = 'claimed'").get(boardId) as { u: string | null }).u;
      const leaseIn = nextLease ? Math.max(25, Date.parse(nextLease) - ctx.now().getTime() + 25) : Infinity;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(remaining, leaseIn));
        const unsub = ctx.hub.subscribe((e: HubEvent) => {
          if (e.kind === "board" && e.boardId === boardId && (e.type === "thread.created" || e.type === "thread.updated")) done();
          else if ((e.kind === "access" && e.principalId === actor.id && e.boardId === boardId) || (e.kind === "board_deleted" && e.boardId === boardId)) done();
        });
        const onAbort = () => done();
        signal?.addEventListener("abort", onAbort, { once: true });
        wake = () => {
          closed = true;
          done();
        };
        function done() {
          clearTimeout(timer);
          unsub();
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
      });
      try {
        return claimOnce(ctx, actor, input);
      } catch (e) {
        if (!(e instanceof OmbError && e.code === "no_task_available")) throw e;
      }
    }
  } finally {
    ctx.connections.unregister(conn);
  }
  throw new OmbError("no_task_available", `No ready task matched within ${Math.round(waitMs / 1000)} seconds`);
}

/** Throws `claim_lost` unless `token` is the caller's live claim on the task. */
function verifyClaim(ctx: AppContext, actor: Actor, thread: ThreadRow, token: string | undefined): void {
  if (!token) throw invalid("This action needs the claim's token");
  if (thread.task_state !== "claimed" || thread.task_assignee_id !== actor.id || thread.task_claim_token !== token || !leaseLive(ctx, thread)) {
    throw new OmbError("claim_lost", "This claim is over: its lease ran out, or the task was released, blocked, canceled or claimed again", {
      state: thread.task_state,
    });
  }
}

/** `renew_task`: extends the caller's live claim from now. */
export function renewTask(ctx: AppContext, actor: Actor, threadId: string, input: { token: string; lease_seconds?: number | undefined }): { thread: Thread; claim: TaskClaim } {
  return tx(ctx, (emit) => {
    const { thread } = requireThread(ctx, actor, threadId, "contributor");
    requireTask(thread);
    verifyClaim(ctx, actor, thread, input.token);
    const until = new Date(ctx.now().getTime() + leaseMs(ctx, thread.board_id, input.lease_seconds)).toISOString();
    ctx.db.prepare("UPDATE threads SET task_lease_until = ? WHERE id = ?").run(until, thread.id);
    changed(ctx, emit, thread, actor.id);
    return { thread: presentThread(ctx, loadThread(ctx, thread.id), actor.id), claim: { epoch: thread.task_claim_epoch, token: input.token, until } };
  });
}

// ---------- update_task ----------

export interface UpdateTaskInput {
  action: TaskAction;
  token?: string | undefined;
  result?: string | undefined;
  reason?: string | undefined;
  kind?: string | undefined;
  for?: string | null | undefined;
  needs?: string[] | undefined;
  idempotency_key?: string | undefined;
}

const ACTION_FIELDS: Record<TaskAction, ReadonlySet<keyof UpdateTaskInput>> = {
  complete: new Set(["token", "result"]),
  fail: new Set(["token", "reason"]),
  release: new Set(["token"]),
  block: new Set(["token", "reason", "kind"]),
  unblock: new Set([]),
  reopen: new Set([]),
  cancel: new Set(["reason"]),
  assign: new Set(["for"]),
  set_needs: new Set(["needs"]),
};

/** Readies the waiting tasks whose last unmet prerequisite was `completedId`. */
function readyDependents(ctx: AppContext, emit: Emit, completedId: string): void {
  const deps = ctx.db
    .prepare("SELECT t.* FROM task_needs n JOIN threads t ON t.id = n.task_id WHERE n.needs_id = ? AND t.task_state = 'waiting'")
    .all(completedId) as ThreadRow[];
  for (const t of deps) {
    if (needsPending(ctx, t.id)) continue;
    ctx.db.prepare("UPDATE threads SET task_state = 'ready', last_activity_at = ? WHERE id = ? AND task_state = 'waiting'").run(nowIso(ctx), t.id);
    changed(ctx, emit, t, null);
  }
}

const CLEAR_CLAIM = "task_assignee_id = NULL, task_claimed_at = NULL, task_lease_until = NULL, task_claim_token = NULL";

/** `update_task`: settle a claimed task with its token, or manage a task as its owner. */
export function updateTask(ctx: AppContext, actor: Actor, threadId: string, input: UpdateTaskInput): { thread: Thread; message: Message | null } {
  const boardId = (ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(threadId) as { board_id: string } | undefined)?.board_id;
  if (boardId) checkWriteRate(ctx, actor, boardId, {});
  return tx(ctx, (emit) => {
    const { thread, membership } = requireThread(ctx, actor, threadId, "contributor");
    const { idempotency_key: key, ...payload } = input;
    return idempotent(ctx, actor, key, { op: "update_task", threadId, ...payload }, () => {
      requireTask(thread);
      const allowed = ACTION_FIELDS[input.action];
      if (!allowed) throw invalid("Unknown task action");
      for (const f of ["token", "result", "reason", "kind", "for", "needs"] as const) {
        if (input[f] !== undefined && !allowed.has(f)) throw invalid(`${f} doesn't apply to ${input.action}`);
      }
      const now = nowIso(ctx);
      const state = thread.task_state;
      const finished = FINISHED.has(state);
      let message: Message | null = null;
      let noop = false;
      switch (input.action) {
        case "complete": {
          verifyClaim(ctx, actor, thread, input.token);
          if (input.result !== undefined && input.result.trim()) message = replyInTx(ctx, emit, actor, thread.id, { body: input.result }, {}).message;
          ctx.db
            .prepare(
              "UPDATE threads SET task_state = 'completed', task_completed_at = ?, task_lease_until = NULL, task_claim_token = NULL, task_result_message_id = ?, task_reason = NULL, last_activity_at = ? WHERE id = ?",
            )
            .run(now, message?.id ?? null, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          readyDependents(ctx, emit, thread.id);
          break;
        }
        case "fail": {
          const reason = validateReason(input.reason, "fail");
          verifyClaim(ctx, actor, thread, input.token);
          ctx.db
            .prepare("UPDATE threads SET task_state = 'failed', task_completed_at = ?, task_lease_until = NULL, task_claim_token = NULL, task_reason = ?, last_activity_at = ? WHERE id = ?")
            .run(now, reason, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "release": {
          verifyClaim(ctx, actor, thread, input.token);
          ctx.db.prepare(`UPDATE threads SET task_state = ?, ${CLEAR_CLAIM}, last_activity_at = ? WHERE id = ?`).run(unclaimedState(ctx, thread.id), now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "block": {
          const reason = validateReason(input.reason, "block");
          const kind = input.kind?.trim() || null;
          if (kind !== null && !TASK_BLOCK_KIND_PATTERN.test(kind)) throw invalid("kind must be lowercase letters, digits, '.', '_' or '-' (up to 32), such as needs_input");
          if (input.token !== undefined) verifyClaim(ctx, actor, thread, input.token);
          else {
            requireTaskOwner(ctx, actor, thread, membership, "block");
            if (finished) throw finishedError(thread);
            if (state === "blocked") throw conflict(thread, "block");
          }
          ctx.db
            .prepare(`UPDATE threads SET task_state = 'blocked', ${CLEAR_CLAIM}, task_reason = ?, task_blocked_kind = ?, last_activity_at = ? WHERE id = ?`)
            .run(reason, kind, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "unblock": {
          requireTaskOwner(ctx, actor, thread, membership, "unblock");
          if (finished) throw finishedError(thread);
          if (state !== "blocked") throw conflict(thread, "unblock");
          ctx.db
            .prepare("UPDATE threads SET task_state = ?, task_reason = NULL, task_blocked_kind = NULL, last_activity_at = ? WHERE id = ?")
            .run(unclaimedState(ctx, thread.id), now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "reopen": {
          requireTaskOwner(ctx, actor, thread, membership, "reopen");
          if (state !== "failed") throw new OmbError("conflict", `Only a failed task can be reopened; this one is ${state}`, { state, action: "reopen" });
          ctx.db
            .prepare(`UPDATE threads SET task_state = ?, ${CLEAR_CLAIM}, task_completed_at = NULL, task_reason = NULL, last_activity_at = ? WHERE id = ?`)
            .run(unclaimedState(ctx, thread.id), now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "cancel": {
          const reason = validateReason(input.reason, "cancel");
          requireTaskOwner(ctx, actor, thread, membership, "cancel");
          if (finished) throw finishedError(thread);
          ctx.db
            .prepare(`UPDATE threads SET task_state = 'canceled', ${CLEAR_CLAIM}, task_completed_at = ?, task_reason = ?, task_blocked_kind = NULL, last_activity_at = ? WHERE id = ?`)
            .run(now, reason, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
        case "assign": {
          if (input.for === undefined) throw invalid("assign needs for: a principal ID, 'me', or null for anyone");
          requireTaskOwner(ctx, actor, thread, membership, "assign");
          if (finished) throw finishedError(thread);
          const forId = input.for === null ? null : resolveClaimant(ctx, actor, thread.board_id, input.for);
          if (forId === thread.task_for_id) {
            noop = true;
            break;
          }
          ctx.db.prepare("UPDATE threads SET task_for_id = ?, last_activity_at = ? WHERE id = ?").run(forId, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          if (forId && forId !== actor.id) {
            const root = ctx.db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1").get(thread.id) as { id: string } | undefined;
            addInboxItem(ctx, emit, { principalId: forId, kind: "task_assigned", boardId: thread.board_id, threadId: thread.id, messageId: root?.id ?? null });
          }
          break;
        }
        case "set_needs": {
          if (input.needs === undefined) throw invalid("set_needs needs needs: the full list of thread IDs (empty for none)");
          requireTaskOwner(ctx, actor, thread, membership, "change the needs of");
          if (finished) throw finishedError(thread);
          if (state === "claimed") {
            throw new OmbError("task_already_claimed", "A claimed task's needs can't change", { assignee: thread.task_assignee_id ? refOf(ctx, thread.task_assignee_id) : null });
          }
          const needs = validateNeeds(ctx, thread.board_id, input.needs, thread.id);
          const current = (ctx.db.prepare("SELECT needs_id FROM task_needs WHERE task_id = ?").all(thread.id) as { needs_id: string }[]).map((r) => r.needs_id);
          if (current.length === needs.length && needs.every((n) => current.includes(n))) {
            noop = true;
            break;
          }
          ctx.db.prepare("DELETE FROM task_needs WHERE task_id = ?").run(thread.id);
          insertNeeds(ctx, thread.id, needs);
          const next = state === "blocked" ? "blocked" : unclaimedState(ctx, thread.id);
          ctx.db.prepare("UPDATE threads SET task_state = ?, last_activity_at = ? WHERE id = ?").run(next, now, thread.id);
          changed(ctx, emit, thread, actor.id);
          break;
        }
      }
      return { thread: presentThread(ctx, noop ? thread : loadThread(ctx, thread.id), actor.id), message };
    });
  });
}

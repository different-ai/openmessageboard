import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { MAX_PLAN_TASKS, TASK_STATE_FILTERS, type TaskAction, type TaskStateFilter } from "@openmessageboard/protocol";
import { OmbError, createIdempotencyKey, isOmbError, type ClaimedTask, type OmbErrorCode, type PlanTask, type TaskClaim, type Thread } from "@openmessageboard/sdk";
import { UsageError, flag, isBoardArg, list, parseDurationSeconds, parseLabels, parsePositiveInt, str, threadIdFrom, type Values } from "./args.js";
import { forgetClaim, loadClaim, saveClaim } from "./claims.js";
import type { Context } from "./commands.js";
import { formatMessage, formatTasks, formatThreadHeader, timeLeft } from "./format.js";
import { readAll } from "./io.js";

type Run = (ctx: Context, args: string[], values: Values, rest: string[]) => Promise<number | void>;

function need(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new UsageError(`Usage: omb ${usage}`);
}

/** An optional leading board or channel argument (a channel ending in `/` is a subtree), merged with --board/--channel. */
function boardOrChannel(first: string | undefined, values: Values): { board: string | undefined; channel: string | undefined } {
  let board = str(values, "board");
  let channel = str(values, "channel");
  if (first !== undefined) {
    if (isBoardArg(first)) {
      if (board) throw new UsageError("Pass the board once: as an argument or with --board");
      board = first;
    } else {
      if (channel) throw new UsageError("Pass the channel once: as an argument or with --channel");
      channel = first;
    }
  }
  return { board, channel };
}

function labelsOf(values: Values): Record<string, string> | undefined {
  const pairs = list(values, "label");
  return pairs.length ? parseLabels(pairs) : undefined;
}

function leaseOf(values: Values): number | undefined {
  const raw = str(values, "lease");
  return raw === undefined ? undefined : parsePositiveInt(raw, "--lease");
}

/** A CLI-side failure reason (not a server error code), e.g. `claim_not_held`. */
function cliError(reason: string, message: string): OmbError {
  return new OmbError(reason as OmbErrorCode, message);
}

/** Stops on Ctrl-C (the returned signal aborts). */
function interruptSignal(ctx: Context): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const dispose = ctx.io.onInterrupt?.(() => abort.abort()) ?? (() => undefined);
  return { signal: abort.signal, dispose };
}

/** Who a stored claim belongs to: the credential and the profile this command runs as. */
function holderOf(ctx: Context): string {
  const c = ctx.connection();
  const credential = c.source === "account" ? `account:${c.account}` : c.source;
  return `${credential}/${c.profile ?? ""}`;
}

function remember(ctx: Context, threadId: string, claim: TaskClaim): void {
  saveClaim(ctx.configPath, ctx.connection().server, holderOf(ctx), threadId, claim);
}

function forget(ctx: Context, threadId: string): void {
  forgetClaim(ctx.configPath, ctx.connection().server, holderOf(ctx), threadId);
}

/** The token for a task: `--token`, else the claim this machine stored when it claimed as the same holder. */
function storedToken(ctx: Context, threadId: string, values: Values): string | undefined {
  return str(values, "token") ?? loadClaim(ctx.configPath, ctx.connection().server, holderOf(ctx), threadId)?.token;
}

function requireToken(ctx: Context, threadId: string, values: Values): string {
  const token = storedToken(ctx, threadId, values);
  if (!token) {
    const as = ctx.connection().profile;
    throw cliError("claim_not_held", `You hold no claim on ${threadId} here${as ? ` as ${as}` : ""}. Claim it with omb tasks claim ${threadId}, or pass --token.`);
  }
  return token;
}


/** Runs a settle call; forgets the stored claim when it succeeds or the claim turns out to be over. */
async function settling<T>(ctx: Context, threadId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    forget(ctx, threadId);
    return out;
  } catch (err) {
    if (isOmbError(err, "claim_lost")) forget(ctx, threadId);
    throw err;
  }
}

// ------------------------------------------------------------------ list and create

async function tasksList(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb tasks [board|channel] [--state <state>|open|all] [--label k=v] [--for <principal>|me] [--mine]");
  const { board, channel } = boardOrChannel(args[0], values);
  const state = str(values, "state") ?? "open";
  if (state !== "all" && !(TASK_STATE_FILTERS as readonly string[]).includes(state)) {
    throw new UsageError(`--state must be one of ${TASK_STATE_FILTERS.join(", ")}, or all`);
  }
  const forArg = str(values, "for");
  const res = await ctx.client().listThreads({
    board_id: await ctx.board(board),
    ...(channel ? { channel } : {}),
    kind: "task",
    ...(state === "all" ? {} : { task_state: state as TaskStateFilter }),
    ...(flag(values, "mine") ? { assignee: "me" } : {}),
    ...(forArg ? { for: forArg } : {}),
    labels: labelsOf(values),
    limit: 100,
  });
  // A queue is worked oldest first.
  const threads = [...res.threads].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (ctx.json) return ctx.printJson({ ...res, threads });
  ctx.out(formatTasks(threads, ctx.now()));
}

const PLAN_KEYS = new Set(["key", "title", "body", "labels", "needs", "for"]);

/** Parses a plan file: a JSON array of `{ key?, title, body, labels?, needs?, for? }`. Unknown keys are refused. */
export function parsePlan(text: string): PlanTask[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError("The plan is not valid JSON");
  }
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { tasks?: unknown }).tasks) ? (raw as { tasks: unknown[] }).tasks : null;
  if (!items) throw new UsageError("A plan is a JSON array of tasks");
  if (items.length === 0 || items.length > MAX_PLAN_TASKS) throw new UsageError(`A plan has 1-${MAX_PLAN_TASKS} tasks; this one has ${items.length}`);
  return items.map((item, i) => {
    const where = `plan task ${i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new UsageError(`${where} is not an object`);
    const t = item as Record<string, unknown>;
    for (const k of Object.keys(t)) if (!PLAN_KEYS.has(k)) throw new UsageError(`${where} has an unknown key "${k}" (use ${[...PLAN_KEYS].join(", ")})`);
    if (typeof t.title !== "string" || !t.title.trim()) throw new UsageError(`${where} needs a title`);
    if (typeof t.body !== "string" || !t.body.trim()) throw new UsageError(`${where} needs a body`);
    if (t.key !== undefined && typeof t.key !== "string") throw new UsageError(`${where}: key must be a string`);
    if (t.for !== undefined && typeof t.for !== "string") throw new UsageError(`${where}: for must be a principal ID`);
    if (t.labels !== undefined && (typeof t.labels !== "object" || t.labels === null || Array.isArray(t.labels))) throw new UsageError(`${where}: labels must be an object`);
    if (t.needs !== undefined) {
      const ok = Array.isArray(t.needs) && t.needs.every((n) => typeof n === "string" || (n && typeof n === "object" && typeof (n as { key?: unknown }).key === "string"));
      if (!ok) throw new UsageError(`${where}: needs lists thread IDs or {"key": "..."} entries`);
    }
    return t as unknown as PlanTask;
  });
}

async function tasksCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  const client = ctx.client();
  const file = str(values, "file");
  if (file !== undefined) {
    if (args.length > 1) throw new UsageError("Usage: omb tasks create [board|channel] --file <plan.json|-> [--idempotency-key <k>]");
    const plan = parsePlan(file === "-" ? await readAll(ctx.io.stdin) : readFileSync(file, "utf8"));
    const { board, channel } = boardOrChannel(args[0], values);
    const boardId = await ctx.board(board);
    const idempotencyKey = str(values, "idempotency-key") ?? createIdempotencyKey();
    const opts = { idempotencyKey, ...(channel ? { channel } : {}) };
    let threads: Thread[];
    try {
      threads = await client.createMany(boardId, plan, opts);
    } catch (err) {
      if (!(isOmbError(err, "network") || isOmbError(err, "timeout"))) throw err;
      threads = await client.createMany(boardId, plan, opts);
    }
    if (ctx.json) return ctx.printJson({ threads });
    ctx.out(threads.map((t) => `Created task ${t.id} [${t.task?.state}] ${t.title}`).join("\n"));
    return;
  }
  if (args.length !== 2 && args.length !== 3) throw new UsageError("Usage: omb tasks create [board|channel] <title> <body|-> [--needs <thread>] [--for <principal>] [--claim]");
  const { board, channel } = boardOrChannel(args.length === 3 ? args[0] : undefined, values);
  const [title, bodyArg] = args.slice(-2) as [string, string];
  const mentions = list(values, "mention");
  const needs = list(values, "needs").map(threadIdFrom);
  const forArg = str(values, "for");
  const res = await client.postIdempotent({
    board_id: await ctx.board(board),
    ...(channel ? { channel } : {}),
    title,
    body: await ctx.body(bodyArg),
    task: true,
    ...(mentions.length ? { mentions } : {}),
    ...(labelsOf(values) ? { labels: labelsOf(values) } : {}),
    ...(needs.length ? { needs } : {}),
    ...(forArg ? { for: forArg } : {}),
    ...(flag(values, "claim") ? { claim: true } : {}),
  });
  if (res.claim) remember(ctx, res.thread.id, res.claim);
  if (ctx.json) return ctx.printJson(res);
  const state = res.thread.task?.state;
  ctx.out(
    res.claim
      ? `Created and claimed task ${res.thread.id} (lease ends in ${timeLeft(res.claim.until, ctx.now())}) ${res.thread.url}`
      : `Created task ${res.thread.id} [${state}] in ${res.thread.channel} ${res.thread.url}`,
  );
}

// ------------------------------------------------------------------ claiming

/** Claims by thread ID, or the oldest ready task with --ready. Resolves null when --wait ran out. */
async function claimFromArgs(ctx: Context, args: string[], values: Values, usage: string, signal?: AbortSignal): Promise<{ claimed: ClaimedTask | null; waited: number | undefined }> {
  const client = ctx.client();
  const labels = labelsOf(values);
  const waitRaw = str(values, "wait");
  const ready = flag(values, "ready") || str(values, "board") !== undefined || str(values, "channel") !== undefined;
  const leaseSeconds = leaseOf(values);
  if (!ready) {
    if (labels || waitRaw !== undefined) throw new UsageError("--label and --wait go with --ready");
    need(args, 1, usage);
    return { claimed: await client.claim(threadIdFrom(args[0]!), { ...(leaseSeconds ? { leaseSeconds } : {}), ...(signal ? { signal } : {}) }), waited: undefined };
  }
  if (args.length > 1) throw new UsageError(`Usage: omb ${usage}`);
  const waitSeconds = waitRaw === undefined ? undefined : parseDurationSeconds(waitRaw, "--wait");
  const { board, channel } = boardOrChannel(args[0], values);
  const boardId = await ctx.board(board);
  const claimed = await client.claimNext(boardId, labels, {
    ...(channel ? { channel } : {}),
    ...(waitSeconds ? { waitSeconds } : {}),
    ...(leaseSeconds ? { leaseSeconds } : {}),
    ...(signal ? { signal } : {}),
  });
  return { claimed, waited: waitSeconds };
}

function noTask(values: Values): string {
  const labels = labelsOf(values);
  return labels ? `No ready task matches ${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(" ")}` : "No ready task";
}

async function tasksClaim(ctx: Context, args: string[], values: Values): Promise<number> {
  const { signal, dispose } = interruptSignal(ctx);
  let result;
  try {
    result = await claimFromArgs(ctx, args, values, "tasks claim <thread> | tasks claim --ready [board] [--label k=v] [--wait <duration>]", signal);
  } catch (err) {
    if (signal.aborted) return 130;
    throw err;
  } finally {
    dispose();
  }
  const { claimed, waited } = result;
  if (!claimed) {
    if (signal.aborted) return 130;
    if (waited === undefined) throw new OmbError("no_task_available", noTask(values));
    ctx.info(`${noTask(values)} within ${waited}s`);
    return 2;
  }
  remember(ctx, claimed.id, claimed.claim);
  if (ctx.json) {
    ctx.printJson({ thread: claimed.thread, claim: claimed.claim });
    return 0;
  }
  const first = await ctx
    .client()
    .getThread({ thread_id: claimed.id, limit: 1 })
    .catch(() => undefined);
  ctx.out(
    [
      `Claimed ${claimed.id} until ${claimed.until} (lease ends in ${timeLeft(claimed.until, ctx.now())}; renew with omb tasks renew ${claimed.id})`,
      formatThreadHeader(claimed.thread, ctx.now()),
      ...(first?.messages[0] ? [formatMessage(first.messages[0], ctx.now())] : []),
    ].join("\n"),
  );
  return 0;
}

// ------------------------------------------------------------------ settling and managing

async function tasksRenew(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "tasks renew <thread> [--lease <seconds>]");
  const threadId = threadIdFrom(args[0]!);
  const token = requireToken(ctx, threadId, values);
  const leaseSeconds = leaseOf(values);
  let res;
  try {
    res = await ctx.client().renewTask({ thread_id: threadId, token, ...(leaseSeconds ? { lease_seconds: leaseSeconds } : {}) });
  } catch (err) {
    if (isOmbError(err, "claim_lost")) forget(ctx, threadId);
    throw err;
  }
  remember(ctx, threadId, res.claim);
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Renewed ${threadId} until ${res.claim.until} (lease ends in ${timeLeft(res.claim.until, ctx.now())})`);
}

async function tasksComplete(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length < 1 || args.length > 2) throw new UsageError("Usage: omb tasks complete <thread> [result|-]");
  const resultFlag = str(values, "result");
  if (args[1] !== undefined && resultFlag !== undefined) throw new UsageError("Pass the result once: as an argument or with --result");
  const resultArg = args[1] ?? resultFlag;
  const result = resultArg === undefined ? undefined : await ctx.body(resultArg);
  const threadId = threadIdFrom(args[0]!);
  const token = requireToken(ctx, threadId, values);
  const res = await settling(ctx, threadId, () =>
    ctx.client().updateTask({ thread_id: threadId, action: "complete", token, ...(result ? { result, idempotency_key: createIdempotencyKey() } : {}) }),
  );
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Completed ${threadId}${res.message ? ` (result posted as ${res.message.id})` : ""}`);
}

async function tasksFail(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "tasks fail <thread> <reason>");
  const threadId = threadIdFrom(args[0]!);
  const token = requireToken(ctx, threadId, values);
  const res = await settling(ctx, threadId, () => ctx.client().updateTask({ thread_id: threadId, action: "fail", token, reason: args[1]! }));
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Failed ${threadId}: ${args[1]}`);
}

async function tasksRelease(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "tasks release <thread>");
  const threadId = threadIdFrom(args[0]!);
  const token = requireToken(ctx, threadId, values);
  const res = await settling(ctx, threadId, () => ctx.client().updateTask({ thread_id: threadId, action: "release", token }));
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Released ${threadId}; it is ${res.thread.task?.state} again`);
}

async function tasksBlock(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "tasks block <thread> <reason> [--kind <kind>]");
  const threadId = threadIdFrom(args[0]!);
  // With a claim, the worker blocks with its token; without one, the task's owner holds an unclaimed task.
  const token = storedToken(ctx, threadId, values);
  const kind = str(values, "kind");
  const res = await settling(ctx, threadId, () =>
    ctx.client().updateTask({ thread_id: threadId, action: "block", reason: args[1]!, ...(token ? { token } : {}), ...(kind ? { kind } : {}) }),
  );
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Blocked ${threadId}: ${args[1]}${kind ? ` (${kind})` : ""}`);
}

function ownerAction(action: Extract<TaskAction, "unblock" | "reopen">): Run {
  return async (ctx, args) => {
    need(args, 1, `tasks ${action} <thread>`);
    const res = await ctx.client().updateTask({ thread_id: threadIdFrom(args[0]!), action });
    if (ctx.json) return ctx.printJson(res);
    ctx.out(`${action === "unblock" ? "Unblocked" : "Reopened"} ${res.thread.id}; it is ${res.thread.task?.state}`);
  };
}

async function tasksAssign(ctx: Context, args: string[], values: Values): Promise<void> {
  const pool = flag(values, "pool");
  if (!(pool ? args.length === 1 : args.length === 2)) throw new UsageError("Usage: omb tasks assign <thread> <principal>|me, or omb tasks assign <thread> --pool");
  const res = await ctx.client().updateTask({ thread_id: threadIdFrom(args[0]!), action: "assign", for: pool ? null : args[1]! });
  if (ctx.json) return ctx.printJson(res);
  const f = res.thread.task?.for;
  ctx.out(f ? `${res.thread.id} is kept for ${f.display_name}` : `${res.thread.id} can be claimed by anyone`);
}

async function tasksNeeds(ctx: Context, args: string[], values: Values): Promise<void> {
  const none = flag(values, "none");
  if (args.length < 1 || (none ? args.length !== 1 : args.length < 2)) throw new UsageError("Usage: omb tasks needs <thread> <thread>..., or omb tasks needs <thread> --none");
  const res = await ctx.client().updateTask({ thread_id: threadIdFrom(args[0]!), action: "set_needs", needs: none ? [] : args.slice(1).map(threadIdFrom) });
  if (ctx.json) return ctx.printJson(res);
  const needs = res.thread.task?.needs ?? [];
  ctx.out(`${res.thread.id} is ${res.thread.task?.state}${needs.length ? `; it needs ${needs.map((n) => `${n.thread_id} (${n.state})`).join(", ")}` : " and needs nothing"}`);
}

async function tasksCancel(ctx: Context, args: string[]): Promise<void> {
  need(args, 2, "tasks cancel <thread> <reason>");
  const threadId = threadIdFrom(args[0]!);
  const res = await ctx.client().updateTask({ thread_id: threadId, action: "cancel", reason: args[1]! });
  forget(ctx, threadId);
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Canceled ${threadId}: ${args[1]}`);
}

// ------------------------------------------------------------------ run

const defaultSpawn = (command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess => nodeSpawn(command, args, { stdio: "inherit", env });

/**
 * Claims a task, runs a command with `OMB_TASK` set, renews at a third of the lease, then completes the task on exit
 * 0 or fails it otherwise. Ctrl-C or SIGTERM releases the task (exit 130 or 143); a lost claim stops the command.
 */
async function tasksRun(ctx: Context, args: string[], values: Values, rest: string[]): Promise<number> {
  if (rest.length === 0) throw new UsageError("Pass the command after --, e.g. omb tasks run t_123 -- npm test");
  const { signal, dispose } = interruptSignal(ctx);
  let result;
  try {
    result = await claimFromArgs(ctx, args, values, "tasks run <thread> | tasks run --ready [board] [--label k=v] [--wait <duration>] -- <command>", signal);
  } catch (err) {
    if (signal.aborted) return 130;
    throw err;
  } finally {
    dispose();
  }
  const { claimed, waited } = result;
  if (!claimed) {
    if (signal.aborted) return 130;
    if (waited === undefined) throw new OmbError("no_task_available", noTask(values));
    ctx.info(`${noTask(values)} within ${waited}s`);
    return 2;
  }
  remember(ctx, claimed.id, claimed.claim);
  const id = claimed.id;
  ctx.info(`Claimed ${id} (lease ends in ${timeLeft(claimed.until)}); running ${rest.join(" ")}`);

  const child = (ctx.io.spawn ?? defaultSpawn)(rest[0]!, rest.slice(1), { ...ctx.io.env, OMB_TASK: id });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, sig) => resolve({ code, signal: sig }));
  });
  let lost = false;
  let stopping: "SIGINT" | "SIGTERM" | null = null;
  let inflight: Promise<void> = Promise.resolve();
  const every = Math.max(250, Math.floor(Math.max(1000, claimed.remainingMs()) / 3));
  const timer = setInterval(() => {
    inflight = inflight.then(async () => {
      if (lost || stopping) return;
      try {
        await claimed.renew();
        remember(ctx, claimed.id, claimed.claim);
      } catch (err) {
        if (isOmbError(err, "claim_lost")) {
          lost = true;
          ctx.info(`omb: claim_lost: the claim on ${id} is over; stopping the command`);
          child.kill("SIGTERM");
        } else {
          ctx.info(`omb: renewing ${id} failed (${err instanceof Error ? err.message : String(err)}); trying again`);
        }
      }
    });
  }, every);
  const unsubs = (["SIGINT", "SIGTERM"] as const).map(
    (sig) =>
      ctx.io.onSignal?.(sig, () => {
        stopping ??= sig;
        child.kill(sig);
      }) ?? (() => undefined),
  );
  const outcome = await exited;
  clearInterval(timer);
  for (const u of unsubs) u();
  await inflight;

  const report = (status: string, code: number, extra: Record<string, unknown> = {}) => {
    if (ctx.json) ctx.printJson({ thread_id: id, status, exit_code: code, ...extra });
    return code;
  };
  if (lost) {
    forget(ctx, id);
    return report("claim_lost", 1);
  }
  if (stopping) {
    await settling(ctx, id, () => claimed.release()).catch((err) => {
      if (!isOmbError(err, "claim_lost")) throw err;
    });
    if (!ctx.json) ctx.info(`Released ${id}`);
    return report("released", stopping === "SIGINT" ? 130 : 143);
  }
  if (outcome.error) {
    const reason = `could not start ${rest[0]}: ${(outcome.error as NodeJS.ErrnoException).code ?? outcome.error.message}`;
    await settling(ctx, id, () => claimed.fail(reason));
    if (!ctx.json) ctx.out(`Failed ${id}: ${reason}`);
    return report("failed", 127, { reason });
  }
  if (outcome.code === 0) {
    const text = str(values, "result");
    const res = await settling(ctx, id, () => claimed.complete(text));
    if (!ctx.json) ctx.out(`Completed ${id}${res.message ? ` (result posted as ${res.message.id})` : ""}`);
    return report("completed", 0);
  }
  const reason = outcome.signal ? `the command was stopped by ${outcome.signal}` : `the command exited with code ${outcome.code}`;
  await settling(ctx, id, () => claimed.fail(reason));
  if (!ctx.json) ctx.out(`Failed ${id}: ${reason}`);
  const code = outcome.code ?? 128 + ((outcome.signal && constants.signals[outcome.signal]) || 0);
  return report("failed", code, { reason });
}

export const TASK_RUNNERS: Record<string, Run> = {
  "tasks list": tasksList,
  "tasks create": tasksCreate,
  "tasks claim": tasksClaim,
  "tasks run": tasksRun,
  "tasks renew": tasksRenew,
  "tasks release": tasksRelease,
  "tasks complete": tasksComplete,
  "tasks fail": tasksFail,
  "tasks block": tasksBlock,
  "tasks unblock": ownerAction("unblock"),
  "tasks reopen": ownerAction("reopen"),
  "tasks assign": tasksAssign,
  "tasks needs": tasksNeeds,
  "tasks cancel": tasksCancel,
};

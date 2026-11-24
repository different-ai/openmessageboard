import { randomBytes } from "node:crypto";
import { EVENT_TYPES, MESSAGE_SOURCES, TASK_STATES, type EventType, type MessageSourceName, type TaskAction, type TaskState } from "@openmessageboard/protocol";
import {
  OmbClient,
  OmbError,
  createIdempotencyKey,
  isInboxItem,
  normalizeServer,
  type Change,
  type ChangeFilters,
  type InboxItem,
  type WatchItem,
  type WatchTarget,
} from "@openmessageboard/sdk";
import {
  UsageError,
  boardIdFrom,
  flag,
  isThreadUrl,
  list,
  parseDuration,
  parseLabels,
  parsePositiveInt,
  parseTime,
  splitOptionalBoard,
  str,
  threadIdFrom,
  type Values,
} from "./args.js";
import { configPath, readConfig, resolveConnection, validateProfile, writeConfig, type Config, type ResolvedConnection } from "./config.js";
import {
  authorName,
  formatBoards,
  formatChange,
  formatInboxItem,
  formatLabels,
  formatMembers,
  formatMessage,
  formatScheduled,
  formatSchedules,
  formatTasks,
  formatWatcherFilter,
  formatWatchers,
  formatThreadHeader,
  formatThreadRow,
  formatUsage,
} from "./format.js";
import { promptHidden, readAll, type Io } from "./io.js";

export const CLI_VERSION = "0.1.0";

export class Context {
  readonly json: boolean;
  readonly configPath: string;
  #config: Config | undefined;
  #conn: ResolvedConnection | undefined;
  #client: OmbClient | undefined;
  #defaultBoard: Promise<string> | undefined;

  constructor(
    readonly io: Io,
    readonly values: Values,
  ) {
    this.json = flag(values, "json");
    this.configPath = configPath(io.env);
  }

  now(): Date {
    return this.io.now?.() ?? new Date();
  }

  out(text: string): void {
    this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  info(text: string): void {
    this.io.stderr.write(`${text}\n`);
  }

  printJson(value: unknown): void {
    this.out(JSON.stringify(value, null, 2));
  }

  get config(): Config {
    this.#config ??= readConfig(this.configPath);
    return this.#config;
  }

  connection(): ResolvedConnection {
    this.#conn ??= resolveConnection({ server: str(this.values, "server"), as: str(this.values, "as"), oidc: str(this.values, "oidc") }, this.io.env, this.config);
    return this.#conn;
  }

  client(): OmbClient {
    if (!this.#client) {
      const c = this.connection();
      this.#client = new OmbClient({
        server: c.server,
        token: c.token,
        tokenProvider: c.tokenProvider,
        clientInfo: { name: "omb", version: CLI_VERSION },
      });
    }
    return this.#client;
  }

  /** Your own board, or your only board (agents have none of their own). */
  defaultBoard(): Promise<string> {
    this.#defaultBoard ??= this.client()
      .whoami()
      .then((me) => {
        if (me.owned_board) return me.owned_board.id;
        if (me.memberships.length === 1) return me.memberships[0]!.board_id;
        throw new UsageError(
          me.memberships.length === 0 ? "You are not on any board yet. Join one with omb join <invite-url>." : "Pass a board ID (you have no board of your own; see omb boards).",
        );
      });
    return this.#defaultBoard;
  }

  async board(arg: string | undefined): Promise<string> {
    return arg ? boardIdFrom(arg) : this.defaultBoard();
  }

  /** A body argument, or stdin when it is `-`. */
  async body(arg: string): Promise<string> {
    const text = arg === "-" ? await readAll(this.io.stdin) : arg;
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) throw new UsageError("The body is empty");
    return trimmed;
  }

  async close(): Promise<void> {
    await this.#client?.close();
  }
}

type Run = (ctx: Context, args: string[], values: Values) => Promise<number | void>;

function need(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new UsageError(`Usage: omb ${usage}`);
}

function labelsOf(values: Values): Record<string, string> | undefined {
  const pairs = list(values, "label");
  return pairs.length ? parseLabels(pairs) : undefined;
}

/** The read_messages filters given on the command line. */
function filtersOf(values: Values, opts: { labels?: boolean } = {}): ChangeFilters {
  const source = str(values, "source");
  if (source !== undefined && !(MESSAGE_SOURCES as readonly string[]).includes(source)) throw new UsageError(`--source must be one of ${MESSAGE_SOURCES.join(", ")}`);
  const labels = opts.labels === false ? undefined : labelsOf(values);
  const f: ChangeFilters = {};
  for (const k of ["by", "mentions", "text", "re"] as const) {
    const v = str(values, k);
    if (v !== undefined) f[k] = k === "re" ? threadIdFrom(v) : v;
  }
  if (labels) f.labels = labels;
  if (source) f.source = source as MessageSourceName;
  return f;
}

const hasFilters = (f: ChangeFilters) => Object.keys(f).length > 0;

/** Runs until Ctrl-C (or the returned promise settles); resolves the abort signal on interrupt. */
function interruptSignal(ctx: Context): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const dispose = ctx.io.onInterrupt?.(() => abort.abort()) ?? (() => undefined);
  return { signal: abort.signal, dispose };
}

function printWatchItem(ctx: Context, item: WatchItem): void {
  if (ctx.json) return ctx.out(JSON.stringify(item));
  ctx.out(isInboxItem(item) ? formatInboxItem(item, ctx.now()) : formatChange(item, ctx.now()));
}

async function login(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 0, "login --server <url> [--token <t>] [--as <profile>]");
  const rawServer = str(values, "server") ?? ctx.io.env.OMB_SERVER ?? ctx.config.server;
  if (!rawServer) throw new UsageError("Usage: omb login --server <url> [--token <t>] [--as <profile>]");
  const server = normalizeServer(rawServer);
  const profile = validateProfile(str(values, "as") ?? "default");
  let token = str(values, "token")?.trim();
  if (!token) {
    ctx.info(`Create a personal access token at ${server}/agents`);
    token = ctx.io.stdin.isTTY ? await promptHidden("Paste the token: ", ctx.io) : (await readAll(ctx.io.stdin)).trim();
  }
  if (!token) throw new UsageError("No token given");
  const client = new OmbClient({ server, token, clientInfo: { name: "omb", version: CLI_VERSION } });
  try {
    const me = await client.whoami();
    const config = ctx.config;
    config.server = server;
    config.profiles[profile] = { token };
    writeConfig(ctx.configPath, config);
    if (ctx.json) return ctx.printJson({ server, profile, principal: me.principal });
    const who = me.principal.owner ? `${me.principal.display_name} (${me.principal.kind}, via ${me.principal.owner.display_name})` : `${me.principal.display_name} (${me.principal.kind})`;
    ctx.out(`Logged in to ${server} as ${who}. Saved to profile "${profile}" in ${ctx.configPath}.`);
  } finally {
    await client.close();
  }
}

async function whoami(ctx: Context): Promise<void> {
  const me = await ctx.client().whoami();
  if (ctx.json) return ctx.printJson(me);
  const p = me.principal;
  const lines = [`${p.owner ? `${p.display_name} (via ${p.owner.display_name})` : p.display_name} · ${p.kind}${p.email ? ` · ${p.email}` : ""} · ${p.id}`];
  lines.push(`Server: ${ctx.connection().server}${ctx.connection().source === "profile" ? ` (profile ${ctx.connection().profile})` : ""}`);
  if (me.owned_board) lines.push(`Your board: ${me.owned_board.name} (${me.owned_board.id}) ${me.owned_board.url}`);
  lines.push(`Boards: ${me.memberships.length}`);
  ctx.out(lines.join("\n"));
}

async function boards(ctx: Context): Promise<void> {
  const me = await ctx.client().whoami();
  if (ctx.json) return ctx.printJson(me.memberships);
  ctx.out(formatBoards(me.memberships));
}

async function readMessages(ctx: Context, boardArg: string | undefined, values: Values): Promise<void> {
  const limitArg = str(values, "limit");
  const after = str(values, "after");
  const before = str(values, "before");
  const res = await ctx.client().messages(await ctx.board(boardArg), {
    ...filtersOf(values),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    ...(limitArg ? { limit: parsePositiveInt(limitArg, "--limit") } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  const parts = res.messages.map((m) => `${m.thread_id} ${formatMessage(m, ctx.now())}`);
  ctx.out(parts.length ? parts.join("\n\n") : "No matching messages.");
  ctx.info(res.has_more && after ? `More: omb read --after ${res.messages[res.messages.length - 1]!.id} …` : `New since: omb read --after ${res.cursor} …`);
}

async function read(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb read [board] [--thread <id>] [--unread] [--label k=v] [--by h] [--mentions [h]] [--text t] [--source s] [--re id] [--after id]");
  const messageMode = flag(values, "messages") || ["by", "mentions", "text", "source", "re", "after", "before"].some((k) => values[k] !== undefined);
  if (messageMode) {
    if (str(values, "thread") || flag(values, "unread")) throw new UsageError("--thread and --unread list threads; use --re to read one thread's matching messages");
    return readMessages(ctx, args[0], values);
  }
  const threadArg = str(values, "thread") ?? (args[0] && isThreadUrl(args[0]) ? args[0] : undefined);
  const client = ctx.client();
  if (threadArg) {
    const res = await client.getThread({ thread_id: threadIdFrom(threadArg), limit: 200 });
    if (ctx.json) return ctx.printJson(res);
    const parts = [formatThreadHeader(res.thread), ...res.messages.map((m) => formatMessage(m, ctx.now()))];
    if (res.next_page_cursor) parts.push("(more messages; use --json and the page cursor)");
    return ctx.out(parts.join("\n\n"));
  }
  const limitArg = str(values, "limit");
  const res = await client.listThreads({
    board_id: await ctx.board(args[0]),
    filter: flag(values, "unread") ? "unread" : undefined,
    labels: labelsOf(values),
    limit: limitArg ? parsePositiveInt(limitArg, "--limit") : undefined,
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.threads.length ? res.threads.map((t) => formatThreadRow(t, ctx.now())).join("\n") : "No threads.");
}

async function post(ctx: Context, args: string[], values: Values, task = false): Promise<void> {
  const usage = task ? "tasks create [board] <title> <body|->" : "post [board] <title> <body|->";
  const { board, rest } = splitOptionalBoard(args, 2, usage);
  const [title, bodyArg] = rest as [string, string];
  const mentions = list(values, "mention");
  const res = await ctx.client().postIdempotent({
    board_id: await ctx.board(board),
    title,
    body: await ctx.body(bodyArg),
    ...(mentions.length ? { mentions } : {}),
    ...(labelsOf(values) ? { labels: labelsOf(values) } : {}),
    ...(task || flag(values, "task") ? { task: true } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`${res.thread.kind === "task" ? "Created task" : "Posted thread"} ${res.thread.id} ${res.thread.url}`);
}

async function reply(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "reply <thread> <body|->");
  const mentions = list(values, "mention");
  const replyTo = str(values, "reply-to");
  const thread_id = threadIdFrom(args[0]!);
  const res = await ctx.client().postIdempotent({
    thread_id,
    body: await ctx.body(args[1]!),
    ...(mentions.length ? { mentions } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Replied ${res.message.id} in ${thread_id}`);
}

async function del(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "delete <message>");
  const res = await ctx.client().deleteMessage({ message_id: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Deleted ${res.message.id}`);
}

function parseTimeoutSeconds(values: Values, fallback: number | undefined): number | undefined {
  const raw = str(values, "timeout");
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new UsageError("--timeout is in seconds");
  const n = Number(raw);
  return n === 0 ? undefined : n;
}

/**
 * `wait <id>` (or `--re`/`--after` with no board): waits in that message's thread for what follows it. The server
 * finds the board from the message, so an answer that is already there comes back at once.
 */
async function waitAfterMessage(ctx: Context, filters: ChangeFilters, after: string, seconds: number | undefined, signal: AbortSignal) {
  const client = ctx.client();
  const deadline = seconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + seconds * 1000;
  let cursor: string | undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const timeout_seconds = Math.max(1, Math.min(25, Math.ceil(remaining / 1000)));
    try {
      const page = await client.waitForActivity({ ...filters, ...(cursor ? { cursor } : { after }), timeout_seconds }, { signal });
      cursor = page.cursor;
      if (page.changes.length) return { changes: page.changes as WatchItem[], cursor: page.cursor };
    } catch (err) {
      if (signal.aborted || !(err instanceof OmbError) || !err.retryable) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function wait(ctx: Context, args: string[], values: Values): Promise<number> {
  if (args.length > 1) throw new UsageError(`Usage: omb wait [<message-id>] [--thread <id> | --board <id> | --mentions [h]] [filters] [--timeout <s>]`);
  const thread = str(values, "thread");
  const board = str(values, "board");
  const id = args[0];
  const after = str(values, "after") ?? (id ? threadIdFrom(id) : undefined);
  if ([thread !== undefined, board !== undefined, id !== undefined].filter(Boolean).length > 1) throw new UsageError("Pick one of <message-id>, --thread, --board");
  const filters = filtersOf(values);
  if (id && !filters.re) filters.re = threadIdFrom(id);
  const client = ctx.client();
  // Bare --mentions with nothing else waits on your inbox for mentions and assigned tasks, as before.
  const inbox = !thread && !board && !after && !filters.re && Object.keys(filters).length <= 1 && (filters.mentions === undefined || filters.mentions === "me");
  // The inbox waits until something arrives; a thread or board waits 5 minutes unless told otherwise.
  const seconds = parseTimeoutSeconds(values, inbox ? undefined : 300);
  const me = await client.me();
  const { signal, dispose } = interruptSignal(ctx);
  try {
    let result: { changes: WatchItem[]; cursor: string } | null;
    if (inbox) {
      result = await client.waitForChanges(
        { inbox: true },
        { timeoutMs: seconds === undefined ? undefined : seconds * 1000, signal, filter: (item: WatchItem) => isInboxItem(item) && (item.kind === "mention" || item.kind === "task_assigned") },
      );
    } else if (thread || board) {
      const target: WatchTarget = thread ? { thread: threadIdFrom(thread) } : { board: boardIdFrom(board!) };
      result = await client.waitForChanges(target, {
        timeoutMs: seconds === undefined ? undefined : seconds * 1000,
        signal,
        ...(after ? { after } : {}),
        filters,
        // Your own changes don't end a wait unless you asked for them with --by.
        filter: (item: WatchItem) => filters.by !== undefined || (item as Change).actor?.id !== me.id,
      });
    } else {
      if (!after && !filters.re) throw new UsageError("Name a board, a thread or a message to wait in (or --mentions for your inbox)");
      result = await waitAfterMessage(ctx, filters, after ?? filters.re!, seconds, signal);
    }
    if (!result) {
      ctx.info(`No activity within ${seconds}s`);
      return 2;
    }
    if (ctx.json) ctx.printJson(result);
    else {
      for (const item of result.changes) printWatchItem(ctx, item);
      if (!inbox) ctx.info(`Wait on: omb wait ${thread ? `--thread ${thread} ` : board ? `--board ${board} ` : ""}--after ${result.cursor}`);
    }
    return 0;
  } catch (err) {
    if (signal.aborted) return 130;
    throw err;
  } finally {
    dispose();
  }
}

async function tail(ctx: Context, args: string[], values: Values): Promise<number> {
  if (args.length > 1) throw new UsageError("Usage: omb tail [board] [--thread <id> | --inbox] [filters] [--after id]");
  const thread = str(values, "thread");
  const filters = filtersOf(values);
  const after = str(values, "after");
  if (flag(values, "inbox") && (hasFilters(filters) || after)) throw new UsageError("Filters and --after apply to a board or thread, not --inbox");
  const target: WatchTarget = flag(values, "inbox")
    ? { inbox: true }
    : thread
      ? { thread: threadIdFrom(thread), ...(args[0] ? { board: boardIdFrom(args[0]) } : {}) }
      : { board: await ctx.board(args[0]) };
  const client = ctx.client();
  const { signal, dispose } = interruptSignal(ctx);
  const handle = client.watch(target, {
    signal,
    ...(hasFilters(filters) ? { filters } : {}),
    ...(after ? { after } : {}),
    onChange: (item) => printWatchItem(ctx, item),
    onStatus: (s) => {
      if (ctx.json) return;
      if (s.state === "live") ctx.info(`Watching (${s.via === "listen" ? "live" : "long polling"}). Ctrl-C to stop.`);
      if (s.state === "reconnecting") ctx.info(`Connection lost; retrying in ${(s.inMs / 1000).toFixed(1)}s`);
    },
  });
  try {
    const error = await handle.done;
    if (error) throw error;
    return 0;
  } finally {
    dispose();
    await handle();
  }
}

async function inbox(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 0, "inbox [--unread] [--mark-read]");
  const client = ctx.client();
  const res = await client.getInbox({ unread_only: flag(values, "unread") || undefined });
  let marked: number | undefined;
  if (flag(values, "mark-read")) {
    const ids = res.items.filter((i: InboxItem) => !i.read_at).map((i) => i.id);
    if (ids.length) marked = (await client.markRead({ item_ids: ids })).marked;
  }
  if (ctx.json) return ctx.printJson(marked === undefined ? res : { ...res, marked });
  const lines = res.items.length ? res.items.map((i) => formatInboxItem(i, ctx.now())) : ["Inbox is empty."];
  lines.push(`${res.unread_count} unread${marked !== undefined ? ` · marked ${marked} read` : ""}`);
  ctx.out(lines.join("\n\n"));
}

async function tasksList(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb tasks list [board] [--state s] [--label k=v] [--mine]");
  const state = str(values, "state");
  if (state && !(TASK_STATES as readonly string[]).includes(state)) throw new UsageError(`--state must be one of ${TASK_STATES.join(", ")}`);
  const res = await ctx.client().listThreads({
    board_id: await ctx.board(args[0]),
    kind: "task",
    task_state: state as TaskState | undefined,
    assignee: flag(values, "mine") ? "me" : undefined,
    labels: labelsOf(values),
    limit: 100,
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatTasks(res.threads));
}

async function tasksClaim(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb tasks claim [<thread>] [--ready] [--board <id>] [--label k=v]");
  const client = ctx.client();
  const labels = labelsOf(values);
  const boardFlag = str(values, "board");
  let thread;
  if (args[0]) {
    thread = (await client.claimTask({ thread_id: threadIdFrom(args[0]) })).thread;
  } else if (flag(values, "ready") || boardFlag || labels) {
    thread = await client.claimNext(await ctx.board(boardFlag), labels);
    if (!thread) throw new OmbError("no_task_available", labels ? `No open task matches ${formatLabels(labels)}` : "No open task");
  } else {
    throw new UsageError("Pass a thread ID, or --ready to claim the oldest open task");
  }
  if (ctx.json) return ctx.printJson({ thread });
  const first = await client.getThread({ thread_id: thread.id, limit: 1 }).catch(() => undefined);
  ctx.out([`Claimed ${thread.id}`, formatThreadHeader(thread), ...(first?.messages[0] ? [formatMessage(first.messages[0], ctx.now())] : [])].join("\n"));
}

function taskAction(action: TaskAction): Run {
  return async (ctx, args, values) => {
    need(args, 1, `tasks ${action} <thread>${action === "complete" ? " [--result <text|->]" : ""}`);
    const resultArg = str(values, "result");
    const result = resultArg === undefined ? undefined : await ctx.body(resultArg);
    const res = await ctx.client().updateTask({
      thread_id: threadIdFrom(args[0]!),
      action,
      ...(result ? { result, idempotency_key: createIdempotencyKey() } : {}),
    });
    if (ctx.json) return ctx.printJson(res);
    const past = { complete: "Completed", release: "Released", cancel: "Cancelled", reopen: "Reopened" }[action];
    ctx.out(`${past} ${res.thread.id}${res.message ? ` (result posted as ${res.message.id})` : ""}`);
  };
}

async function label(ctx: Context, args: string[], values: Values): Promise<void> {
  const remove = list(values, "remove");
  if (args.length < 1 || (args.length === 1 && remove.length === 0)) throw new UsageError("Usage: omb label <thread> k=v ... [--remove k ...]");
  const set = args.length > 1 ? parseLabels(args.slice(1)) : undefined;
  const res = await ctx.client().setLabels({ thread_id: threadIdFrom(args[0]!), ...(set ? { set } : {}), ...(remove.length ? { remove } : {}) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`${res.thread.id}: ${formatLabels(res.thread.labels) || "(no labels)"}`);
}

async function invite(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb invite [board] --link|--email <e>|--domain <d> --role reader|contributor");
  const email = str(values, "email");
  const domain = str(values, "domain");
  const audiences = [flag(values, "link") && "link", email !== undefined && "email", domain !== undefined && "domain"].filter(Boolean) as Array<"link" | "email" | "domain">;
  if (audiences.length !== 1) throw new UsageError("Pick exactly one of --link, --email <address>, --domain <domain>");
  const role = str(values, "role");
  if (role !== "reader" && role !== "contributor") throw new UsageError("--role must be reader or contributor");
  const joinBy = str(values, "join-by");
  const accessEnds = str(values, "access-ends");
  const maxUses = str(values, "max-uses");
  const now = ctx.now();
  const res = await ctx.client().createInvite({
    board_id: await ctx.board(args[0]),
    audience: audiences[0]!,
    ...(email ? { value: email } : domain ? { value: domain } : {}),
    role,
    ...(joinBy ? { join_by: parseTime(joinBy, now) } : {}),
    ...(accessEnds ? { access_ends_at: parseTime(accessEnds, now) } : {}),
    ...(maxUses ? { max_uses: parsePositiveInt(maxUses, "--max-uses") } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  const inv = res.invite;
  const rules = [inv.role, inv.audience === "link" ? "anyone signed in" : `${inv.audience} ${inv.audience_value}`];
  if (inv.join_by) rules.push(`join by ${inv.join_by}`);
  if (inv.access_ends_at) rules.push(`access ends ${inv.access_ends_at}`);
  if (inv.max_uses) rules.push(`${inv.max_uses} use${inv.max_uses === 1 ? "" : "s"}`);
  ctx.out(`${inv.url ?? "(no URL returned)"}\n${rules.join(" · ")}`);
}

async function join(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "join <invite-url>");
  const res = await ctx.client().redeemInvite({ invite: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Joined ${res.board.name} (${res.board.id}) as ${res.board.my_role}${res.board.my_access_ends_at ? ` until ${res.board.my_access_ends_at}` : ""}`);
}

function follow(following: boolean): Run {
  return async (ctx, args) => {
    need(args, 1, `${following ? "follow" : "unfollow"} <thread>`);
    const res = await ctx.client().setFollow({ thread_id: threadIdFrom(args[0]!), following });
    if (ctx.json) return ctx.printJson(res);
    ctx.out(`${res.following ? "Following" : "Not following"} ${res.thread_id}`);
  };
}

async function search(ctx: Context, args: string[]): Promise<void> {
  const { board, rest } = splitOptionalBoard(args, 1, "search [board] <query>");
  const res = await ctx.client().searchMessages({ board_id: await ctx.board(board), query: rest[0]! });
  if (ctx.json) return ctx.printJson(res);
  if (!res.results.length) return ctx.out("No matches.");
  ctx.out(
    res.results
      .map((r) => `${r.thread_title} (${r.message.thread_id}) · ${authorName(r.message.author)} · ${r.message.created_at.slice(0, 10)} · ${r.message.id}\n  ${r.snippet}`)
      .join("\n"),
  );
}

async function members(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb members [board]");
  const res = await ctx.client().listMembers({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatMembers(res.members));
}

async function usage(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb usage [board]");
  const res = await ctx.client().getUsage({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatUsage(res));
}

async function schedule(ctx: Context, args: string[], values: Values): Promise<void> {
  const title = str(values, "title");
  const usage = "schedule <board|thread> <text|-> [--title <t>] [--in 1d] [--at <time>] [--every 1h] [--times n] [--until <time>]";
  let target: { board_id: string; title: string } | { thread_id: string };
  let textArg: string;
  if (title !== undefined) {
    const { board, rest } = splitOptionalBoard(args, 1, usage);
    target = { board_id: await ctx.board(board), title };
    textArg = rest[0]!;
  } else {
    need(args, 2, `${usage} (without --title, the first argument is the thread to reply in)`);
    target = { thread_id: threadIdFrom(args[0]!) };
    textArg = args[1]!;
  }
  const now = ctx.now();
  const opt = (name: string) => str(values, name);
  const labels = labelsOf(values);
  const mentions = list(values, "mention");
  if (labels && "thread_id" in target) throw new UsageError("--label applies to new threads (with --title)");
  const res = await ctx.client().schedulePost({
    ...target,
    body: await ctx.body(textArg),
    ...(labels ? { labels } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(opt("in") ? { in_seconds: parseDuration(opt("in")!, "--in") } : {}),
    ...(opt("at") ? { at: parseTime(opt("at")!, now) } : {}),
    ...(opt("every") ? { every_seconds: parseDuration(opt("every")!, "--every") } : {}),
    ...(opt("times") ? { times: parsePositiveInt(opt("times")!, "--times") } : {}),
    ...(opt("until") ? { until: parseTime(opt("until")!, now) } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatScheduled(res.schedule));
}

async function scheduleCancel(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "schedule cancel <schedule>");
  const res = await ctx.client().cancelSchedule({ schedule_id: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.cancelled ? `Cancelled ${res.schedule.id}` : `${res.schedule.id} was already ${res.schedule.state}`);
}

async function schedules(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb schedules [board|thread] [--all]");
  const client = ctx.client();
  const all = flag(values, "all") || undefined;
  let res;
  if (args[0] && isThreadUrl(args[0])) res = await client.listSchedules({ thread_id: threadIdFrom(args[0]), all });
  else if (!args[0]) res = await client.listSchedules({ board_id: await ctx.defaultBoard(), all });
  else {
    // A bare ID may name a board or a thread.
    try {
      res = await client.listSchedules({ board_id: boardIdFrom(args[0]), all });
    } catch (err) {
      if (!(err instanceof OmbError) || err.code !== "not_found") throw err;
      res = await client.listSchedules({ thread_id: args[0], all });
    }
  }
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatSchedules(res.schedules));
}

async function watchers(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb watchers [board]");
  const res = await ctx.client().listWatchers({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatWatchers(res.watchers));
}

async function watchersCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb watchers create [board] --url <https-url> [filters]");
  const url = str(values, "url");
  if (!url) throw new UsageError("--url is required");
  const types = list(values, "type");
  for (const t of types) if (!(EVENT_TYPES as readonly string[]).includes(t)) throw new UsageError(`--type must be one of ${EVENT_TYPES.join(", ")}`);
  const generated = str(values, "secret") === undefined;
  const secret = str(values, "secret") ?? `whsec_${randomBytes(32).toString("base64")}`;
  const { re: _re, ...filters } = filtersOf(values);
  const thread = str(values, "thread") ?? str(values, "re");
  const res = await ctx.client().createWatcher({
    board_id: await ctx.board(args[0]),
    url,
    secret,
    filter: { ...filters, ...(thread ? { thread: threadIdFrom(thread) } : {}), ...(types.length ? { types: types as EventType[] } : {}) },
  });
  if (ctx.json) return ctx.printJson(generated ? { ...res, secret } : res);
  ctx.out(`Created ${res.watcher.id} → ${res.watcher.url} (${formatWatcherFilter(res.watcher.filter)})`);
  if (generated) ctx.out(`Signing secret (shown once; verify the webhook-signature header with it):\n${secret}`);
}

async function watchersDelete(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "watchers delete <watcher>");
  const res = await ctx.client().deleteWatcher({ watcher_id: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Deleted ${res.watcher_id}`);
}

export const RUNNERS: Record<string, Run> = {
  login,
  whoami,
  boards,
  read,
  post: (ctx, args, values) => post(ctx, args, values),
  reply,
  delete: del,
  wait,
  tail,
  inbox,
  "tasks list": tasksList,
  "tasks create": (ctx, args, values) => post(ctx, args, values, true),
  "tasks claim": tasksClaim,
  "tasks complete": taskAction("complete"),
  "tasks release": taskAction("release"),
  "tasks cancel": taskAction("cancel"),
  "tasks reopen": taskAction("reopen"),
  label,
  invite,
  join,
  follow: follow(true),
  unfollow: follow(false),
  search,
  members,
  usage,
  schedule,
  "schedule cancel": scheduleCancel,
  schedules,
  watchers,
  "watchers create": watchersCreate,
  "watchers delete": watchersDelete,
};

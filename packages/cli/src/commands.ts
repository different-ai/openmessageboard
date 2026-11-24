import { TASK_STATES, type TaskAction, type TaskState } from "@openmessageboard/protocol";
import {
  OmbClient,
  OmbError,
  createIdempotencyKey,
  isInboxItem,
  normalizeServer,
  type Change,
  type InboxItem,
  type TokenScope,
  type WatchItem,
  type WatchTarget,
} from "@openmessageboard/sdk";
import {
  UsageError,
  boardIdFrom,
  flag,
  isThreadUrl,
  list,
  parseDurationSeconds,
  parseLabels,
  parsePositiveInt,
  parseTime,
  splitOptionalBoard,
  str,
  threadIdFrom,
  type Values,
} from "./args.js";
import { configPath, readConfig, resolveConnection, validateAccount, validateProfileName, writeConfig, type Config, type ResolvedConnection } from "./config.js";
import {
  authorName,
  formatActors,
  formatBoards,
  formatChange,
  formatInboxItem,
  formatLabels,
  formatMembers,
  formatMessage,
  formatTasks,
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
    if (!this.#conn) {
      const as = str(this.values, "as");
      const account = str(this.values, "account");
      this.#conn = resolveConnection({ server: str(this.values, "server"), account, as, oidc: str(this.values, "oidc") }, this.io.env, this.config);
      // `--as` used to pick a saved token; it now names a profile. Point people with such a saved token at --account.
      if (as && account === undefined && this.config.accounts[as]?.token && !this.json) {
        this.info(`omb: writing as profile "${as}" of your default credential. To use the token saved as "${as}", pass --account ${as}.`);
      }
    }
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
        profile: c.profile,
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
  need(args, 0, "login --server <url> [--token <t>] [--account <name>]");
  if (str(values, "as") !== undefined) throw new UsageError("login saves a token under an account: use --account <name> (--as names a profile to write as)");
  const rawServer = str(values, "server") ?? ctx.io.env.OMB_SERVER ?? ctx.config.server;
  if (!rawServer) throw new UsageError("Usage: omb login --server <url> [--token <t>] [--account <name>]");
  const server = normalizeServer(rawServer);
  const account = validateAccount(str(values, "account") ?? "default");
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
    config.accounts[account] = { token };
    writeConfig(ctx.configPath, config);
    if (ctx.json) return ctx.printJson({ server, account, principal: me.principal });
    const who = me.principal.owner ? `${me.principal.display_name} (${me.principal.kind}, via ${me.principal.owner.display_name})` : `${me.principal.display_name} (${me.principal.kind})`;
    ctx.out(`Logged in to ${server} as ${who}. Saved to account "${account}" in ${ctx.configPath}.`);
  } finally {
    await client.close();
  }
}

async function whoami(ctx: Context): Promise<void> {
  const me = await ctx.client().whoami();
  if (ctx.json) return ctx.printJson(me);
  const p = me.principal;
  const lines = [`${p.owner ? `${p.display_name} (via ${p.owner.display_name})` : p.display_name} · ${p.profile ? "profile" : p.kind}${p.email ? ` · ${p.email}` : ""} · ${p.id}`];
  lines.push(`Server: ${ctx.connection().server}${ctx.connection().source === "account" ? ` (account ${ctx.connection().account})` : ""}`);
  if (p.scope) lines.push(`Token scope: ${describeScope(p.scope)}`);
  if (me.owned_board) lines.push(`Your board: ${me.owned_board.name} (${me.owned_board.id}) ${me.owned_board.url}`);
  lines.push(`Boards: ${me.memberships.length}`);
  ctx.out(lines.join("\n"));
}

async function boards(ctx: Context): Promise<void> {
  const me = await ctx.client().whoami();
  if (ctx.json) return ctx.printJson(me.memberships);
  ctx.out(formatBoards(me.memberships));
}

async function read(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb read [board] [--thread <id>] [--unread] [--label k=v]");
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

async function wait(ctx: Context, args: string[], values: Values): Promise<number> {
  need(args, 0, "wait [--thread <id> | --mentions | --board <id>] [--timeout <s>]");
  const thread = str(values, "thread");
  const board = str(values, "board");
  const chosen = [thread !== undefined, board !== undefined, flag(values, "mentions")].filter(Boolean).length;
  if (chosen > 1) throw new UsageError("Pick one of --thread, --board, --mentions");
  const client = ctx.client();
  const target: WatchTarget = thread ? { thread: threadIdFrom(thread) } : board ? { board: boardIdFrom(board) } : { inbox: true };
  // Mentions wait until something arrives; a thread or board waits 5 minutes unless told otherwise.
  const seconds = parseTimeoutSeconds(values, "inbox" in target ? undefined : 300);
  const me = await client.me();
  const { signal, dispose } = interruptSignal(ctx);
  try {
    const result = await client.waitForChanges(target, {
      timeoutMs: seconds === undefined ? undefined : seconds * 1000,
      signal,
      filter: (item: WatchItem) =>
        isInboxItem(item) ? item.kind === "mention" || item.kind === "task_assigned" : (item as Change).actor?.id !== me.id,
    });
    if (!result) {
      ctx.info(`No activity within ${seconds}s`);
      return 2;
    }
    if (ctx.json) ctx.printJson(result);
    else for (const item of result.changes) printWatchItem(ctx, item);
    return 0;
  } catch (err) {
    if (signal.aborted) return 130;
    throw err;
  } finally {
    dispose();
  }
}

async function tail(ctx: Context, args: string[], values: Values): Promise<number> {
  if (args.length > 1) throw new UsageError("Usage: omb tail [board] [--thread <id> | --inbox]");
  const thread = str(values, "thread");
  const target: WatchTarget = flag(values, "inbox")
    ? { inbox: true }
    : thread
      ? { thread: threadIdFrom(thread), ...(args[0] ? { board: boardIdFrom(args[0]) } : {}) }
      : { board: await ctx.board(args[0]) };
  const client = ctx.client();
  const { signal, dispose } = interruptSignal(ctx);
  const handle = client.watch(target, {
    signal,
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

async function actors(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb actors [board]");
  const res = await ctx.client().listActors({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatActors(res.actors));
}

function describeScope(scope: TokenScope): string {
  const parts = [scope.can.length === 1 ? "read only" : scope.can.join(", ")];
  parts.push(scope.boards ? `boards ${scope.boards.join(", ")}` : "every board");
  if (scope.profile) parts.push(`as ${scope.profile}`);
  if (scope.expires_at) parts.push(`expires ${scope.expires_at}`);
  return parts.join(" · ");
}

/**
 * Prints a short-lived, narrowed token on stdout (so `TOKEN=$(omb tokens create …)` works) and what it can do on
 * stderr. `--as` here names the profile the token always writes as; the request itself is made as you.
 */
async function tokensCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 0, "tokens create [--board <id> ...] [--read-only] [--as <profile>] [--expires 1h]");
  const boardArgs = list(values, "board").map(boardIdFrom);
  const expires = str(values, "expires");
  const profile = str(values, "as") ?? (ctx.io.env.OMB_PROFILE?.trim() || undefined);
  const label = str(values, "label");
  const input = {
    ...(boardArgs.length ? { boards: boardArgs } : {}),
    ...(flag(values, "read-only") ? { can: ["read" as const] } : {}),
    ...(profile ? { profile: validateProfileName(profile) } : {}),
    ...(expires ? { expires_in_seconds: parseDurationSeconds(expires, "--expires") } : {}),
    ...(label ? { label } : {}),
  };
  const asPerson = ctx.client().as(null);
  const res = await asPerson.createScopedToken(input).finally(() => asPerson.close());
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.token);
  ctx.info(`Token ${res.prefix}… (${describeScope(res.scope)}). Shown once: hand it to the agent as OMB_TOKEN; never post it.`);
}

async function usage(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb usage [board]");
  const res = await ctx.client().getUsage({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatUsage(res));
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
  actors,
  "tokens create": tokensCreate,
  usage,
};

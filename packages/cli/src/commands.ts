import { randomBytes } from "node:crypto";
import { runChannel, type ChannelSubscription } from "./channel.js";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { EVENT_TYPES, MESSAGE_SOURCES, SUBSCRIPTION_LEVELS, type EventType, type GrantPrincipal, type MessageSourceName, type SubscriptionLevel } from "@openmessageboard/protocol";
import {
  OmbClient,
  OmbError,
  isInboxItem,
  normalizeServer,
  type Change,
  type ChangeFilters,
  type InboxItem,
  type TokenScope,
  type WatchItem,
  type WatchTarget,
} from "@openmessageboard/sdk";
import {
  UsageError,
  boardIdFrom,
  flag,
  isBoardArg,
  isThreadUrl,
  parseCan,
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
  formatAccess,
  formatActors,
  formatBoards,
  formatChange,
  formatChannels,
  formatGrants,
  formatInboxItem,
  formatLabels,
  formatMembers,
  formatMessage,
  formatScheduled,
  formatSchedules,
  formatWatcherFilter,
  formatWatchers,
  formatThreadHeader,
  formatThreadRow,
  formatUsage,
  formatSchema,
} from "./format.js";
import { promptHidden, readAll, type Io } from "./io.js";
import { TASK_RUNNERS } from "./tasks.js";

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

type Run = (ctx: Context, args: string[], values: Values, rest: string[]) => Promise<number | void>;

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
  for (const k of ["channel", "by", "mentions", "text", "re"] as const) {
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
  need(args, 0, "login --server <url> [--account <name>]");
  if (str(values, "as") !== undefined) throw new UsageError("login saves a token under an account: use --account <name> (--as names a profile to write as)");
  // A token on the command line is visible to every other process on the machine (spec 13 §Configuration).
  if (str(values, "token") !== undefined) {
    throw new UsageError("omb does not take a token as an argument, where other processes can read it. Paste it when asked, pipe it in (printf %s \"$TOKEN\" | omb login --server <url>), or set OMB_TOKEN.");
  }
  const rawServer = str(values, "server") ?? ctx.io.env.OMB_SERVER ?? ctx.config.server;
  if (!rawServer) throw new UsageError("Usage: omb login --server <url> [--account <name>]");
  const server = normalizeServer(rawServer);
  const account = validateAccount(str(values, "account") ?? "default");
  if (ctx.io.stdin.isTTY) ctx.info(`Create a personal access token at ${server}/agents`);
  const token = ctx.io.stdin.isTTY ? await promptHidden("Paste the token: ", ctx.io) : (await readAll(ctx.io.stdin)).trim();
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

/** Tools whose writes need an idempotency key; `call` supplies one when the caller gives none (spec 13 §Retries). */
const NEEDS_IDEMPOTENCY_KEY = new Set(["start_thread", "reply"]);

/** `omb call <tool>`: any tool, by the name and arguments the specification gives it. Standard output is the tool's result. */
async function call(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "call <tool> [--input <json> | --input @<file> | --input -]");
  const tool = args[0]!;
  const raw = str(values, "input");
  let input: Record<string, unknown> = {};
  if (raw !== undefined) {
    let text: string;
    if (raw === "-") text = await readAll(ctx.io.stdin);
    else if (raw.startsWith("@")) {
      try {
        text = readFileSync(raw.slice(1), "utf8");
      } catch (err) {
        throw new UsageError(`Cannot read ${raw.slice(1)}: ${(err as Error).message}`);
      }
    } else text = raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UsageError("--input is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--input must be a JSON object");
    input = parsed as Record<string, unknown>;
  }
  if (NEEDS_IDEMPOTENCY_KEY.has(tool) && input.idempotency_key === undefined) input = { ...input, idempotency_key: `cli_${randomBytes(12).toString("hex")}` };
  ctx.printJson(await ctx.client().callRaw(tool, input));
}

/** `omb tools`: what the server lists, unchanged. */
async function tools(ctx: Context): Promise<void> {
  ctx.printJson({ tools: await ctx.client().listTools() });
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

async function boards(ctx: Context, args: string[]): Promise<void> {
  need(args, 0, "boards");
  const me = await ctx.client().whoami();
  if (ctx.json) return ctx.printJson(me.memberships);
  ctx.out(formatBoards(me.memberships));
}

async function boardsCreate(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "boards create <name>");
  const res = await ctx.client().createBoard({ name: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Created board ${res.board.name} (${res.board.id}) ${res.board.url}`);
}

async function boardsSave(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "boards save <board>");
  const res = await ctx.client().saveBoard({ board_id: boardIdFrom(args[0]!) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Saved ${res.board.name} (${res.board.id}). Your agents and profiles can now read its public channels.`);
}

async function boardsUnsave(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "boards unsave <board>");
  const res = await ctx.client().unsaveBoard({ board_id: boardIdFrom(args[0]!) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Removed ${res.board_id} from your saved boards.`);
}

/** An optional leading board-or-channel argument, plus --board and --channel. */
function boardAndChannel(first: string | undefined, values: Values): { board: string | undefined; channel: string | undefined } {
  let board = str(values, "board");
  let channel = str(values, "channel");
  if (first !== undefined) {
    if (isBoardArg(first)) {
      if (board) throw new UsageError("Pass the board once: as the first argument or with --board");
      board = first;
    } else {
      if (channel) throw new UsageError("Pass the channel once: as the first argument or with --channel");
      channel = first;
    }
  }
  return { board, channel };
}

async function readMessages(ctx: Context, boardArg: string | undefined, channel: string | undefined, values: Values): Promise<void> {
  const limitArg = str(values, "limit");
  const after = str(values, "after");
  const before = str(values, "before");
  const res = await ctx.client().messages(await ctx.board(boardArg), {
    ...filtersOf(values),
    ...(channel ? { channel } : {}),
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
  if (args.length > 1) {
    throw new UsageError("Usage: omb read [board|channel|channel/] [--thread <id>] [--unread] [--label k=v] [--by h] [--mentions [h]] [--text t] [--source s] [--re id] [--after id]");
  }
  const messageMode = flag(values, "messages") || ["by", "mentions", "text", "source", "re", "after", "before"].some((k) => values[k] !== undefined);
  if (messageMode) {
    if (str(values, "thread") || flag(values, "unread")) throw new UsageError("--thread and --unread list threads; use --re to read one thread's matching messages");
    const { board, channel } = boardAndChannel(args[0], values);
    return readMessages(ctx, board, channel, values);
  }
  const threadArg = str(values, "thread") ?? (args[0] && isThreadUrl(args[0]) ? args[0] : undefined);
  const client = ctx.client();
  if (threadArg) {
    const res = await client.getThread({ thread_id: threadIdFrom(threadArg), limit: 200 });
    if (ctx.json) return ctx.printJson(res);
    const parts = [formatThreadHeader(res.thread, ctx.now()), ...res.messages.map((m) => formatMessage(m, ctx.now()))];
    if (res.next_page_cursor) parts.push("(more messages; use --json and the page cursor)");
    return ctx.out(parts.join("\n\n"));
  }
  const limitArg = str(values, "limit");
  const { board, channel } = boardAndChannel(args[0], values);
  const res = await client.listThreads({
    board_id: await ctx.board(board),
    ...(channel ? { channel } : {}),
    filter: flag(values, "unread") ? "unread" : undefined,
    labels: labelsOf(values),
    limit: limitArg ? parsePositiveInt(limitArg, "--limit") : undefined,
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.threads.length ? res.threads.map((t) => formatThreadRow(t, ctx.now())).join("\n") : "No threads.");
}

const MEDIA_TYPES: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/** Uploads each --attach file to the board and returns the attachment IDs. */
async function uploadAll(ctx: Context, boardId: string, values: Values): Promise<string[]> {
  const ids: string[] = [];
  for (const path of list(values, "attach")) {
    let data: Uint8Array;
    try {
      data = readFileSync(path);
    } catch (err) {
      throw new UsageError(`Can't read ${path}: ${(err as Error).message}`);
    }
    const name = basename(path);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const attachment = await ctx.client().upload(boardId, { data, name, type: MEDIA_TYPES[ext] ?? "application/octet-stream" });
    if (!ctx.json) ctx.info(`Uploaded ${attachment.name} (${attachment.size} bytes) as ${attachment.id}`);
    ids.push(attachment.id);
  }
  return ids;
}

function parseSchemaRef(input: string): { schema: string; version: number } {
  const m = /^(.+)@(\d+)$/.exec(input.trim());
  if (!m) throw new UsageError(`--schema takes name@version, such as git-commit@1`);
  return { schema: m[1]!, version: Number(m[2]) };
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${what} is not JSON: ${(err as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * The body and structured data for post and reply. With --schema and --data, the body stays text; with --schema
 * alone, the body argument is the data and the text names the schema.
 */
async function bodyAndBlocks(ctx: Context, bodyArg: string, values: Values) {
  const schemaArg = str(values, "schema");
  const dataArg = str(values, "data");
  if (!schemaArg) {
    if (dataArg !== undefined) throw new UsageError("--data needs --schema name@version");
    return { body: await ctx.body(bodyArg) };
  }
  const ref = parseSchemaRef(schemaArg);
  if (dataArg !== undefined) {
    const data = parseJsonObject(dataArg === "-" ? await readAll(ctx.io.stdin) : dataArg, "--data");
    return { body: await ctx.body(bodyArg), blocks: [{ ...ref, data }] };
  }
  const data = parseJsonObject(bodyArg === "-" ? await readAll(ctx.io.stdin) : bodyArg, "The data");
  return { body: `${ref.schema}@${ref.version}`, blocks: [{ ...ref, data }] };
}

async function post(ctx: Context, args: string[], values: Values): Promise<void> {
  const usage = "post [board|channel] <title> <body|->";
  if (args.length !== 2 && args.length !== 3) throw new UsageError(`Usage: omb ${usage}`);
  const { board, channel } = boardAndChannel(args.length === 3 ? args[0] : undefined, values);
  const [title, bodyArg] = args.slice(-2) as [string, string];
  const mentions = list(values, "mention");
  const boardId = await ctx.board(board);
  const content = await bodyAndBlocks(ctx, bodyArg, values);
  const attachments = await uploadAll(ctx, boardId, values);
  const res = await ctx.client().postIdempotent({
    board_id: boardId,
    ...(channel ? { channel } : {}),
    title,
    ...content,
    ...(mentions.length ? { mentions } : {}),
    ...(labelsOf(values) ? { labels: labelsOf(values) } : {}),
    ...(flag(values, "task") ? { task: true } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`${res.thread.kind === "task" ? "Created task" : "Posted thread"} ${res.thread.id} in ${res.thread.channel} ${res.thread.url}`);
  reportMentions(ctx, res.mentions_resolved);
}

function reportMentions(ctx: Context, resolved: { written: string; principal: { display_name: string } | null; candidates: unknown[] }[] | undefined): void {
  for (const m of resolved ?? []) {
    if (m.principal) ctx.info(`Mentioned ${m.principal.display_name} (${m.written})`);
    else ctx.info(`${m.written} ${m.candidates.length ? `matches ${m.candidates.length} members` : "matches no member"}; left as text`);
  }
}

async function reply(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "reply <thread> <body|->");
  const mentions = list(values, "mention");
  const replyTo = str(values, "reply-to");
  const after = str(values, "after");
  const thread_id = threadIdFrom(args[0]!);
  const content = await bodyAndBlocks(ctx, args[1]!, values);
  let attachments: string[] = [];
  if (list(values, "attach").length) {
    const { thread } = await ctx.client().getThread({ thread_id, limit: 1 });
    attachments = await uploadAll(ctx, thread.board_id, values);
  }
  const res = await ctx.client().postIdempotent({
    thread_id,
    ...content,
    ...(mentions.length ? { mentions } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(after ? { after } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Replied ${res.message.id} in ${thread_id}`);
  reportMentions(ctx, res.mentions_resolved);
}

async function edit(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "edit <message> <body|-> [--if-revision n]");
  const rev = str(values, "if-revision");
  const res = await ctx.client().editMessage({
    message_id: args[0]!,
    body: await ctx.body(args[1]!),
    ...(rev ? { revision: parsePositiveInt(rev, "--if-revision") } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`edited ${res.message.id} (revision ${res.message.revision})`);
  reportMentions(ctx, res.mentions_resolved);
}

async function reactCmd(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 2, "react <message> <emoji> [--remove]");
  const remove = flag(values, "remove");
  const res = await ctx.client().react({ message_id: args[0]!, emoji: args[1]!, ...(remove ? { remove: true } : {}) });
  if (ctx.json) return ctx.printJson(res);
  const summary = res.message.reactions.map((r) => `${r.emoji} ${r.count}`).join(" · ");
  ctx.out(`${remove ? "unreacted" : "reacted"} ${res.message.id}${summary ? ` (${summary})` : ""}`);
}

async function download(ctx: Context, args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 2) throw new UsageError("Usage: omb download <attachment> [path|-]");
  const file = await ctx.client().download(args[0]!);
  const target = args[1];
  if (target === "-") {
    (ctx.io.stdout as { write(data: string | Uint8Array): unknown }).write(file.data);
    return;
  }
  const path = target ?? basename(file.name.replace(/\\/g, "/")) ?? args[0]!;
  writeFileSync(path, file.data);
  if (ctx.json) return ctx.printJson({ path, name: file.name, type: file.type, size: file.data.byteLength });
  ctx.out(`Saved ${path} (${file.data.byteLength} bytes, ${file.type})`);
}

async function schemasList(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb schemas [list] [board]");
  const res = await ctx.client().listSchemas({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.schemas.map((s) => `${s.id}${s.builtin ? " (built in)" : ""}${s.description ? ` · ${s.description}` : ""}`).join("\n") || "No schemas.");
}

async function schemasInspect(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "schemas inspect <name@version> [--board <id>]");
  const res = await ctx.client().getSchema({ board_id: await ctx.board(str(values, "board")), schema: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatSchema(res.schema));
}

async function schemasCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "schemas create <name@version> --file <path|-> | --data <json> [--description <text>] [--board <id>]");
  const m = /^(.+)@(\d+)$/.exec(args[0]!.trim());
  if (!m) throw new UsageError("Name the schema as name@version, such as sandbox@1");
  const file = str(values, "file");
  const data = str(values, "data");
  if ((file === undefined) === (data === undefined)) throw new UsageError("Pass the JSON Schema with --file <path|-> or --data <json>");
  let text: string;
  if (data !== undefined) text = data;
  else if (file === "-") text = await readAll(ctx.io.stdin);
  else {
    try {
      text = readFileSync(file!, "utf8");
    } catch (err) {
      throw new UsageError(`Can't read ${file}: ${(err as Error).message}`);
    }
  }
  const description = str(values, "description");
  const res = await ctx.client().registerSchema({
    board_id: await ctx.board(str(values, "board")),
    name: m[1]!,
    version: Number(m[2]),
    schema: parseJsonObject(text, "The schema"),
    ...(description ? { description } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(res.created ? `Registered ${res.schema.id}` : `${res.schema.id} is already registered with this definition`);
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
  // --inbox waits for any new inbox item (spec 13 §Waiting); --after then takes an inbox cursor.
  const wholeInbox = flag(values, "inbox");
  if ([thread !== undefined, board !== undefined, id !== undefined, wholeInbox].filter(Boolean).length > 1) throw new UsageError("Pick one of <message-id>, --thread, --board, --inbox");
  const filters = filtersOf(values);
  if (wholeInbox && Object.keys(filters).length) throw new UsageError("--inbox takes no filters");
  if (id && !filters.re) filters.re = threadIdFrom(id);
  const client = ctx.client();
  // Bare --mentions with nothing else waits on your inbox for mentions and assigned tasks, as before.
  const inbox = wholeInbox || (!thread && !board && !after && !filters.re && Object.keys(filters).length <= 1 && (filters.mentions === undefined || filters.mentions === "me"));
  // The inbox waits until something arrives; a thread or board waits 5 minutes unless told otherwise.
  const seconds = parseTimeoutSeconds(values, inbox ? undefined : 300);
  const me = await client.me();
  const { signal, dispose } = interruptSignal(ctx);
  try {
    let result: { changes: WatchItem[]; cursor: string } | null;
    if (inbox) {
      result = await client.waitForChanges(
        { inbox: true },
        {
          timeoutMs: seconds === undefined ? undefined : seconds * 1000,
          signal,
          ...(wholeInbox && after ? { cursor: after } : {}),
          filter: (item: WatchItem) => isInboxItem(item) && (wholeInbox || item.kind === "mention" || item.kind === "task_assigned"),
        },
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
      // With --json, standard output is one JSON document on every path: an empty page, with the cursor the caller gave.
      if (ctx.json) ctx.printJson({ changes: [], cursor: after ?? null });
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

async function label(ctx: Context, args: string[], values: Values): Promise<void> {
  const unset = [...list(values, "unset"), ...list(values, "remove")];
  const ifSet = list(values, "if");
  const ifUnset = list(values, "if-unset");
  if (args.length < 1 || (args.length === 1 && unset.length === 0)) {
    throw new UsageError("Usage: omb label <message|thread> [k=v ...] [--unset k ...] [--if k=v ...] [--if-unset k ...]");
  }
  const set = args.length > 1 ? parseLabels(args.slice(1)) : undefined;
  const conditions: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(ifSet.length ? parseLabels(ifSet) : {})) conditions[k] = v;
  for (const k of ifUnset) conditions[k.trim()] = null;
  const client = ctx.client();
  // A thread's labels are its root message's labels.
  const target = args[0]!;
  let messageId = target;
  if (isThreadUrl(target) || /^t_/.test(target)) {
    const { messages } = await client.getThread({ thread_id: threadIdFrom(target), limit: 1 });
    if (!messages[0]) throw new OmbError("not_found", "Thread not found");
    messageId = messages[0].id;
  }
  const res = await client.labelMessage({
    message_id: messageId,
    ...(set ? { set } : {}),
    ...(unset.length ? { unset } : {}),
    ...(Object.keys(conditions).length ? { if: conditions } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`labeled ${res.message.id}: ${formatLabels(res.message.labels) || "(no labels)"}`);
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

async function schedule(ctx: Context, args: string[], values: Values): Promise<void> {
  const title = str(values, "title");
  const usage = "schedule <board|thread> <text|-> [--title <t>] [--in 1d] [--at <time>] [--every 1h] [--times n] [--until <time>]";
  let target: { board_id: string; title: string; channel?: string } | { thread_id: string };
  let textArg: string;
  const channel = str(values, "channel");
  if (title !== undefined) {
    const { board, rest } = splitOptionalBoard(args, 1, usage);
    target = { board_id: await ctx.board(board), title, ...(channel ? { channel } : {}) };
    textArg = rest[0]!;
  } else {
    if (channel) throw new UsageError("--channel applies to new threads (with --title); a reply posts in its thread's channel");
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
    ...(opt("in") ? { in_seconds: parseDurationSeconds(opt("in")!, "--in") } : {}),
    ...(opt("at") ? { at: parseTime(opt("at")!, now) } : {}),
    ...(opt("every") ? { every_seconds: parseDurationSeconds(opt("every")!, "--every") } : {}),
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

const SUBSCRIPTION_LEVEL_NAMES: readonly string[] = SUBSCRIPTION_LEVELS;

async function subscribe(ctx: Context, args: string[], values: Values): Promise<void> {
  const { board, rest } = splitOptionalBoard(args, 1, "subscribe [board] <pattern> [--level all|threads|mentions|mute]");
  const level = str(values, "level") ?? "threads";
  if (!SUBSCRIPTION_LEVEL_NAMES.includes(level)) throw new UsageError(`--level is one of ${SUBSCRIPTION_LEVELS.join(", ")}`);
  const res = await ctx.client().setSubscription({ board_id: await ctx.board(board), pattern: rest[0]!, level: level as SubscriptionLevel });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Subscribed to ${rest[0]} at ${level}.`);
}

async function unsubscribe(ctx: Context, args: string[]): Promise<void> {
  const { board, rest } = splitOptionalBoard(args, 1, "unsubscribe [board] <pattern>");
  const res = await ctx.client().setSubscription({ board_id: await ctx.board(board), pattern: rest[0]!, level: null });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Removed the subscription at ${rest[0]}.`);
}

async function subscriptionsList(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb subscriptions [board]");
  const res = await ctx.client().listSubscriptions(args[0] ? { board_id: boardIdFrom(args[0]) } : {});
  if (ctx.json) return ctx.printJson(res);
  if (!res.subscriptions.length) return ctx.out("No subscriptions. The default applies everywhere: mentions, replies in threads you follow, tasks assigned to you.");
  ctx.out(res.subscriptions.map((s) => `${s.level.padEnd(9)} ${s.pattern.padEnd(28)} ${s.board_id}`).join("\n"));
}

async function channelsList(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb channels [board]");
  const res = await ctx.client().listChannels({ board_id: await ctx.board(args[0]) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatChannels(res.channels, ctx.now()));
}

async function channelsCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  const { board, rest } = splitOptionalBoard(args, 1, "channels create [board] <channel> [--private]");
  const res = await ctx.client().createChannel({ board_id: await ctx.board(board), path: rest[0]!, ...(flag(values, "private") ? { private: true } : {}) });
  if (ctx.json) return ctx.printJson(res);
  const lines = [`${res.created ? "Created" : "Already exists:"} ${res.channel.path}${res.channel.private ? " (private)" : ""}`];
  if (res.grants.length) lines.push(`Grants: ${res.grants.map((g) => g.id).join(", ")}. Let others in with omb grants update ${res.grants[0]!.id} --add-member <id>.`);
  ctx.out(lines.join("\n"));
}

/** Resolves member arguments (principal IDs or @handles) to principal IDs. */
async function memberIds(ctx: Context, boardId: string, inputs: string[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const { members } = await ctx.client().listMembers({ board_id: boardId });
  return inputs.map((input) => {
    const handle = input.replace(/^@/, "");
    const m = members.find((x) => x.principal.id === input) ?? members.find((x) => x.handle === handle);
    if (!m) throw new UsageError(`No member ${input} on this board (see omb members)`);
    return m.principal.id;
  });
}

async function grantsList(ctx: Context, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb grants [board]");
  const boardId = await ctx.board(args[0]);
  const client = ctx.client();
  const res = await client.listGrants({ board_id: boardId });
  if (ctx.json) return ctx.printJson(res);
  const members = res.grants.some((g) => g.principals.some((p) => p.kind === "member")) ? (await client.listMembers({ board_id: boardId })).members : [];
  ctx.out(formatGrants(res.grants, members));
}

async function grantsCreate(ctx: Context, args: string[], values: Values): Promise<void> {
  if (args.length > 1) throw new UsageError("Usage: omb grants create [board] --member <id> ... --can 'pattern=perms'");
  const boardId = await ctx.board(args[0]);
  const principals: GrantPrincipal[] = (await memberIds(ctx, boardId, list(values, "member"))).map((principal_id) => ({ kind: "member", principal_id }));
  for (const g of ["readers", "contributors", "everyone", "public"] as const) if (flag(values, g)) principals.push({ kind: g });
  if (principals.length === 0) throw new UsageError("Name who the grant is for: --member <id|handle>, --readers, --contributors, --everyone or --public");
  const res = await ctx.client().createGrant({ board_id: boardId, principals, can: parseCan(list(values, "can")) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Created grant ${res.grant.id}`);
}

async function grantsUpdate(ctx: Context, args: string[], values: Values): Promise<void> {
  need(args, 1, "grants update <grant> [--add-member <id>] [--remove-member <id>] [--can 'pattern=perms']");
  const addMembers = list(values, "add-member");
  const removeMembers = list(values, "remove-member");
  // Handles are resolved on the board (--board, or your default board); a removed member's ID is passed through.
  const boardId = addMembers.length || removeMembers.length ? await ctx.board(str(values, "board")) : undefined;
  const add: GrantPrincipal[] = boardId ? (await memberIds(ctx, boardId, addMembers)).map((principal_id) => ({ kind: "member", principal_id })) : [];
  const remove: GrantPrincipal[] = [];
  for (const m of removeMembers) {
    const [id] = await memberIds(ctx, boardId!, [m]).catch(() => [m.replace(/^@/, "")]);
    remove.push({ kind: "member", principal_id: id! });
  }
  for (const g of ["readers", "contributors", "everyone"] as const) {
    if (flag(values, `add-${g}`)) add.push({ kind: g });
    if (flag(values, `remove-${g}`)) remove.push({ kind: g });
  }
  const canPairs = list(values, "can");
  if (!add.length && !remove.length && !canPairs.length) throw new UsageError("Nothing to change: pass --add-…, --remove-… or --can");
  const res = await ctx.client().updateGrant({
    grant_id: args[0]!,
    ...(add.length ? { add } : {}),
    ...(remove.length ? { remove } : {}),
    ...(canPairs.length ? { can: parseCan(canPairs) } : {}),
  });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Updated grant ${res.grant.id}`);
}

async function grantsRevoke(ctx: Context, args: string[]): Promise<void> {
  need(args, 1, "grants revoke <grant>");
  const res = await ctx.client().revokeGrant({ grant_id: args[0]! });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(`Revoked grant ${res.grant_id}`);
}

async function grantsExplain(ctx: Context, args: string[], values: Values): Promise<void> {
  const { board, rest } = splitOptionalBoard(args, 1, "grants explain [board] <channel> [--member <id|handle>]");
  const boardId = await ctx.board(board);
  const member = str(values, "member");
  const [principal_id] = member ? await memberIds(ctx, boardId, [member]) : [];
  const res = await ctx.client().explainAccess({ board_id: boardId, channel: rest[0]!, ...(principal_id ? { principal_id } : {}) });
  if (ctx.json) return ctx.printJson(res);
  ctx.out(formatAccess(res));
}

async function channel(ctx: Context, args: string[], values: Values): Promise<number> {
  if (args.length) throw new UsageError("Usage: omb channel [--board <id> ...] [--messages] [--tasks [--channel <c>] [--label k=v ...]]");
  const boards = (Array.isArray(values.board) ? values.board : typeof values.board === "string" ? [values.board] : []).map(boardIdFrom);
  if ((flag(values, "messages") || flag(values, "tasks")) && boards.length === 0) throw new UsageError("--messages and --tasks need --board <id>");
  if ((str(values, "channel") || labelsOf(values)) && !flag(values, "tasks")) throw new UsageError("--channel and --label narrow --tasks");
  const subscriptions: ChannelSubscription[] = [];
  if (boards.length === 0) subscriptions.push({ name: "inbox.item_created", arguments: {} });
  for (const board_id of boards) {
    subscriptions.push({ name: "inbox.item_created", arguments: { board_id } });
    if (flag(values, "messages")) subscriptions.push({ name: "board.message_created", arguments: { board_id } });
    if (flag(values, "tasks")) {
      const labels = labelsOf(values);
      const channelName = str(values, "channel");
      subscriptions.push({ name: "board.task_updated", arguments: { board_id, state: "ready", ...(channelName ? { channel: channelName } : {}), ...(labels ? { labels } : {}) } });
    }
  }
  const heartbeat = Number(ctx.io.env.OMB_CHANNEL_HEARTBEAT_MS);
  const { signal, dispose } = interruptSignal(ctx);
  try {
    return await runChannel({ client: ctx.client(), io: ctx.io, version: CLI_VERSION, subscriptions, signal, ...(heartbeat > 0 ? { heartbeatMs: heartbeat } : {}) });
  } finally {
    dispose();
  }
}

export const RUNNERS: Record<string, Run> = {
  call,
  tools,
  login,
  whoami,
  "boards list": boards,
  "boards create": boardsCreate,
  "boards save": boardsSave,
  "boards unsave": boardsUnsave,
  "channels list": channelsList,
  "channels create": channelsCreate,
  "grants list": grantsList,
  "grants create": grantsCreate,
  "grants update": grantsUpdate,
  "grants revoke": grantsRevoke,
  "grants explain": grantsExplain,
  read,
  post,
  reply,
  delete: del,
  edit,
  react: reactCmd,
  download,
  "schemas list": schemasList,
  "schemas inspect": schemasInspect,
  "schemas create": schemasCreate,
  wait,
  tail,
  inbox,
  channel,
  ...TASK_RUNNERS,
  label,
  invite,
  join,
  subscribe,
  unsubscribe,
  subscriptions: subscriptionsList,
  follow: follow(true),
  unfollow: follow(false),
  search,
  members,
  actors,
  "tokens create": tokensCreate,
  usage,
  schedule,
  "schedule cancel": scheduleCancel,
  schedules,
  watchers,
  "watchers create": watchersCreate,
  "watchers delete": watchersDelete,
};

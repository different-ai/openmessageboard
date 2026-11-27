import { parseArgs } from "node:util";
import {
  CHANNEL_FILTER_PATTERN,
  GRANT_PATTERN_PATTERN,
  LABEL_KEY_PATTERN,
  MAX_LABEL_VALUE,
  MAX_LABELS,
  PERMISSIONS,
  type GrantCanInput,
  type Permission,
} from "@openmessageboard/protocol";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** `optionalValue`: a string option that may be given bare (`--mentions`), meaning this value. */
type OptionSpec = { type: "string" | "boolean"; short?: string; multiple?: boolean; optionalValue?: string };
export type Options = Record<string, OptionSpec>;
export type Values = Record<string, string | boolean | string[] | undefined>;

export const GLOBAL_OPTIONS = {
  server: { type: "string" },
  account: { type: "string" },
  as: { type: "string" },
  json: { type: "boolean" },
  oidc: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies Options;

const label = { type: "string", multiple: true } as const;
/** The read_messages filters, shared by read, wait, tail and watchers create. */
const filterOptions = {
  channel: { type: "string" },
  by: { type: "string" },
  mentions: { type: "string", optionalValue: "me" },
  label,
  text: { type: "string" },
  source: { type: "string" },
  re: { type: "string" },
} as const satisfies Options;
const attach = { type: "string", multiple: true } as const;

export interface CommandSpec {
  usage: string;
  summary: string;
  options?: Options;
}

/** Every command, keyed by its words ("tasks claim"). */
export const COMMANDS: Record<string, CommandSpec> = {
  call: {
    usage: "call <tool> [--input <json> | --input @<file> | --input -]",
    summary: "Call any tool by name with JSON arguments and print its result as JSON (spec 13)",
    options: { input: { type: "string" } },
  },
  tools: { usage: "tools", summary: "Print the tools the server lists, with their schemas, as JSON (spec 13)" },
  login: { usage: "login --server <url> [--account <name>]", summary: "Save a personal access token or agent token (pasted, or piped on standard input)", options: { token: { type: "string" } } },
  whoami: { usage: "whoami", summary: "Who you are and your own board" },
  "boards list": { usage: "boards", summary: "Boards you can access" },
  "boards create": { usage: "boards create <name>", summary: "Create another named board you own (up to your plan's boards_owned)" },
  "channels list": { usage: "channels [board]", summary: "Channels you can read, with thread counts" },
  "channels create": {
    usage: "channels create [board] <channel> [--private]",
    summary: "Create a channel before anything posts to it; --private closes it to everyone but you",
    options: { private: { type: "boolean" } },
  },
  read: {
    usage:
      "read [board|channel|channel/] [--board <id>] [--channel <c>] [--thread <id>] [--unread] [--label k=v] [--by h] [--mentions [h]] [--text t] [--source s] [--re id] [--after id] [--messages] [-n n]",
    summary: "List threads (in a channel, or a subtree with a trailing /), read one thread, or read messages that match filters",
    options: {
      thread: { type: "string" },
      unread: { type: "boolean" },
      board: { type: "string" },
      ...filterOptions,
      after: { type: "string" },
      before: { type: "string" },
      messages: { type: "boolean" },
      limit: { type: "string", short: "n" },
    },
  },
  post: {
    usage:
      "post [board|channel] <title> <body|-> [--board <id>] [--channel <c>] [--task] [--label k=v ...] [--mention <principal-id> ...] [--attach <file> ...] [--schema name@v [--data <json|->]]",
    summary: "Start a thread, in general unless a channel is given (- reads the body from stdin; with --schema and no --data, the body is the JSON data)",
    options: {
      task: { type: "boolean" },
      label,
      mention: { type: "string", multiple: true },
      board: { type: "string" },
      channel: { type: "string" },
      attach,
      schema: { type: "string" },
      data: { type: "string" },
    },
  },
  reply: {
    usage: "reply <thread> <body|-> [--mention <principal-id> ...] [--reply-to <message>] [--after <message>] [--attach <file> ...] [--schema name@v [--data <json|->]]",
    summary: "Reply in a thread (--after: only while that message is still the newest)",
    options: {
      mention: { type: "string", multiple: true },
      "reply-to": { type: "string" },
      after: { type: "string" },
      attach,
      schema: { type: "string" },
      data: { type: "string" },
    },
  },
  delete: { usage: "delete <message>", summary: "Delete a message (leaves a tombstone)" },
  edit: { usage: "edit <message> <body|-> [--if-revision n]", summary: "Replace a message's text (yours, or your agent's)", options: { "if-revision": { type: "string" } } },
  react: { usage: "react <message> <emoji> [--remove]", summary: "React to a message (eyes, +1, :tada: or the emoji)", options: { remove: { type: "boolean" } } },
  download: { usage: "download <attachment> [path|-]", summary: "Save an attachment (to its own name, a path, or stdout with -)" },
  "schemas list": { usage: "schemas [list] [board]", summary: "Schemas for structured data on a board" },
  "schemas inspect": { usage: "schemas inspect <name@version> [--board <id>]", summary: "Print one schema", options: { board: { type: "string" } } },
  "schemas create": {
    usage: "schemas create <name@version> --file <path|-> | --data <json> [--description <text>] [--board <id>]",
    summary: "Register a schema (board owners); a version never changes",
    options: { file: { type: "string" }, data: { type: "string" }, description: { type: "string" }, board: { type: "string" } },
  },
  wait: {
    usage: "wait [<message-id>] [--thread <id> | --board <id> | --inbox | --mentions [h]] [--by h] [--label k=v] [--text t] [--source s] [--re id] [--after id] [--timeout <s>]",
    summary: "Block until matching activity arrives (exit 0), or time out (exit 2)",
    options: { thread: { type: "string" }, board: { type: "string" }, inbox: { type: "boolean" }, ...filterOptions, after: { type: "string" }, timeout: { type: "string" } },
  },
  tail: {
    usage: "tail [board] [--thread <id> | --inbox] [--by h] [--mentions [h]] [--label k=v] [--text t] [--source s] [--re id] [--after id]",
    summary: "Stream changes live",
    options: { thread: { type: "string" }, inbox: { type: "boolean" }, ...filterOptions, after: { type: "string" } },
  },
  schedule: {
    usage: "schedule <board|thread> <text|-> [--title <t> [--channel <c>]] [--in 1d] [--at <time>] [--every 1h] [--times n] [--until <time>] [--label k=v] [--mention <id>]",
    summary: "Post later, once or repeating (--title starts a new thread each run)",
    options: {
      title: { type: "string" },
      channel: { type: "string" },
      in: { type: "string" },
      at: { type: "string" },
      every: { type: "string" },
      times: { type: "string" },
      until: { type: "string", short: "u" },
      label,
      mention: { type: "string", multiple: true },
    },
  },
  "schedule cancel": { usage: "schedule cancel <schedule>", summary: "Cancel a scheduled post" },
  schedules: { usage: "schedules [board|thread] [--all]", summary: "Pending scheduled posts (--all adds finished ones)", options: { all: { type: "boolean", short: "a" } } },
  watchers: { usage: "watchers [board]", summary: "Watchers on a board and their recent deliveries (board owners)" },
  "watchers create": {
    usage: "watchers create [board] --url <https-url> [--secret whsec_…] [--thread id] [--type t ...] [--by h] [--mentions h] [--label k=v] [--text t] [--source s]",
    summary: "POST matching changes, signed, to a URL (board owners)",
    options: { url: { type: "string" }, secret: { type: "string" }, thread: { type: "string" }, type: { type: "string", multiple: true }, ...filterOptions, mentions: { type: "string" } },
  },
  "watchers delete": { usage: "watchers delete <watcher>", summary: "Delete a watcher" },
  channel: {
    usage: "channel [--board <id> ...] [--messages] [--tasks [--channel <c>] [--label k=v ...]]",
    summary:
      "Run as a Claude Code channel (stdio): mentions, replies and assignments (and with --messages every message, with --tasks ready tasks) on the given boards start Claude's next turn",
    options: { board: { type: "string", multiple: true }, messages: { type: "boolean" }, tasks: { type: "boolean" }, channel: { type: "string" }, label },
  },
  inbox: { usage: "inbox [--unread] [--mark-read]", summary: "Mentions, replies in threads you follow, tasks assigned to you", options: { unread: { type: "boolean" }, "mark-read": { type: "boolean" } } },
  "tasks list": {
    usage: "tasks [list] [board|channel] [--board <id>] [--channel <c|c/>] [--state <state>|open|all] [--label k=v] [--for <principal>|me] [--mine]",
    summary: "List tasks, oldest first (open ones unless --state says otherwise)",
    options: { state: { type: "string" }, label, for: { type: "string" }, mine: { type: "boolean" }, board: { type: "string" }, channel: { type: "string" } },
  },
  "tasks create": {
    usage: "tasks create [board|channel] <title> <body|-> [--label k=v ...] [--needs <thread> ...] [--for <principal>|me] [--claim] | tasks create [board|channel] --file <plan.json|-> [--idempotency-key <k>]",
    summary: "Create a task, or a plan of up to 15 tasks from a JSON file",
    options: {
      board: { type: "string" },
      channel: { type: "string" },
      label,
      mention: { type: "string", multiple: true },
      needs: { type: "string", multiple: true },
      for: { type: "string" },
      claim: { type: "boolean" },
      file: { type: "string" },
      "idempotency-key": { type: "string" },
    },
  },
  "tasks claim": {
    usage: "tasks claim <thread> | tasks claim --ready [board|channel|subtree/] [--label k=v ...] [--wait <duration>] [--lease <seconds>]",
    summary: "Claim a task for a lease, or the oldest ready task matching labels (kept-for-you first)",
    options: { ready: { type: "boolean" }, board: { type: "string" }, channel: { type: "string" }, label, wait: { type: "string" }, lease: { type: "string" } },
  },
  "tasks run": {
    usage: "tasks run <thread> | tasks run --ready [board|channel|subtree/] [--label k=v ...] [--wait <duration>] [--result <text>] -- <command> [args...]",
    summary: "Claim a task, run a command with OMB_TASK set, renew while it runs, then complete (exit 0) or fail it",
    options: {
      ready: { type: "boolean" },
      board: { type: "string" },
      channel: { type: "string" },
      label,
      wait: { type: "string" },
      lease: { type: "string" },
      result: { type: "string" },
    },
  },
  "tasks renew": { usage: "tasks renew <thread> [--lease <seconds>]", summary: "Extend your claim's lease from now", options: { lease: { type: "string" }, token: { type: "string" } } },
  "tasks release": { usage: "tasks release <thread>", summary: "Return a task you hold to the queue", options: { token: { type: "string" } } },
  "tasks complete": {
    usage: "tasks complete <thread> [result|-] [--result <text|->]",
    summary: "Finish a task you hold, optionally posting a result",
    options: { result: { type: "string" }, token: { type: "string" } },
  },
  "tasks fail": { usage: "tasks fail <thread> <reason>", summary: "Give up on a task you hold", options: { token: { type: "string" } } },
  "tasks block": {
    usage: "tasks block <thread> <reason> [--kind <kind>]",
    summary: "Hold a task for a person (as its worker, or as its owner when unclaimed)",
    options: { kind: { type: "string" }, token: { type: "string" } },
  },
  "tasks unblock": { usage: "tasks unblock <thread>", summary: "Lift a hold, as the task's owner" },
  "tasks reopen": { usage: "tasks reopen <thread>", summary: "Make a failed task ready again, as its owner" },
  "tasks assign": { usage: "tasks assign <thread> <principal>|me | tasks assign <thread> --pool", summary: "Keep a task for one member or agent, or return it to anyone", options: { pool: { type: "boolean" } } },
  "tasks needs": { usage: "tasks needs <thread> <thread>... | tasks needs <thread> --none", summary: "Replace the tasks a task waits for", options: { none: { type: "boolean" } } },
  "tasks cancel": { usage: "tasks cancel <thread> <reason>", summary: "Call a task off, as its owner" },
  label: {
    usage: "label <message|thread> [k=v ...] [--unset k ...] [--if k=v ...] [--if-unset k ...]",
    summary: "Set or remove labels on a message (a thread's labels are its first message's)",
    options: {
      unset: { type: "string", multiple: true },
      remove: { type: "string", multiple: true },
      if: { type: "string", multiple: true },
      "if-unset": { type: "string", multiple: true },
    },
  },
  invite: {
    usage: "invite [board] --link|--email <e>|--domain <d> --role reader|contributor [--join-by <time>] [--access-ends <time>] [--max-uses n]",
    summary: "Create an invite link (board owners)",
    options: {
      link: { type: "boolean" },
      email: { type: "string" },
      domain: { type: "string" },
      role: { type: "string" },
      "join-by": { type: "string" },
      "access-ends": { type: "string" },
      "max-uses": { type: "string" },
    },
  },
  join: { usage: "join <invite-url>", summary: "Join a board with an invite link" },
  follow: { usage: "follow <thread>", summary: "Follow a thread" },
  unfollow: { usage: "unfollow <thread>", summary: "Stop following a thread" },
  search: { usage: "search [board] <query>", summary: "Search messages on a board" },
  members: { usage: "members [board]", summary: "Members, roles and who agents act for" },
  actors: { usage: "actors [board]", summary: "People, agents and profiles on a board, with their handles" },
  "tokens create": {
    usage: "tokens create [--board <id> ...] [--read-only] [--as <profile>] [--expires 1h] [--label <text>]",
    summary: "Create a short-lived, narrowed token to hand to a sandboxed agent (printed once)",
    options: { board: { type: "string", multiple: true }, "read-only": { type: "boolean" }, expires: { type: "string" }, label: { type: "string" } },
  },
  usage: { usage: "usage [board]", summary: "Allowances and current use (board owners)" },
  "grants list": { usage: "grants [board]", summary: "Grants you can manage, with their IDs" },
  "grants create": {
    usage: "grants create [board] (--member <id|handle> ... | --readers | --contributors | --everyone) --can 'pattern=perms' ...",
    summary: "Open or narrow access per channel (perms: read,post,react,label,manage, all or none)",
    options: { member: { type: "string", multiple: true }, readers: { type: "boolean" }, contributors: { type: "boolean" }, everyone: { type: "boolean" }, can: { type: "string", multiple: true } },
  },
  "grants update": {
    usage: "grants update <grant> [--add-member <id|handle> ...] [--remove-member <id|handle> ...] [--add-<group>|--remove-<group>] [--can 'pattern=perms' ...]",
    summary: "Add or remove a grant's principals, or replace what it gives",
    options: {
      "add-member": { type: "string", multiple: true },
      "remove-member": { type: "string", multiple: true },
      "add-readers": { type: "boolean" },
      "remove-readers": { type: "boolean" },
      "add-contributors": { type: "boolean" },
      "remove-contributors": { type: "boolean" },
      "add-everyone": { type: "boolean" },
      "remove-everyone": { type: "boolean" },
      can: { type: "string", multiple: true },
      board: { type: "string" },
    },
  },
  "grants revoke": { usage: "grants revoke <grant>", summary: "Remove a grant" },
  "grants explain": {
    usage: "grants explain [board] <channel> [--member <id|handle>]",
    summary: "Which grant decides what you (or a member) can do in a channel",
    options: { member: { type: "string" } },
  },
};

export interface ParsedCommandLine {
  /** Command key, e.g. "read" or "tasks claim". Undefined when only global flags were given. */
  command: string | undefined;
  positionals: string[];
  values: Values;
  /** `tasks run` only: the command after `--`. */
  rest: string[];
}

/** Commands that take a command line after `--`. */
const TAKES_REST = new Set(["tasks run"]);

const GROUPS = new Set(["tasks", "tokens", "boards", "channels", "grants", "schemas"]);
/** Groups that run a default subcommand when the next word isn't one of theirs (`omb tasks b_1` lists). */
const DEFAULT_SUBCOMMAND: Record<string, string> = { tasks: "list", boards: "list", channels: "list", grants: "list", schemas: "list" };
/** Commands that are also groups: `schedule cancel`, `watchers create`. Other words are arguments. */
const OPTIONAL_GROUPS: Record<string, string[]> = { schedule: ["cancel"], watchers: ["create", "delete"] };

/** Expands a bare `--name` of an option with an optional value into `--name=<value>`. */
function expandOptionalValues(argv: string[], options: Options): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const spec = arg.startsWith("--") && !arg.includes("=") ? options[arg.slice(2)] : undefined;
    const next = argv[i + 1];
    if (spec?.optionalValue !== undefined && (next === undefined || next.startsWith("-"))) out.push(`${arg}=${spec.optionalValue}`);
    else out.push(arg);
  }
  return out;
}

function parseArgsOptions(options: Options): Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> {
  return Object.fromEntries(Object.entries(options).map(([k, { optionalValue: _ignored, ...spec }]) => [k, spec]));
}

/**
 * Parses `omb [global flags] <command> [args] [flags]`. Global flags may appear anywhere.
 * Throws UsageError for unknown commands or flags.
 */
export function parseCommandLine(argv: string[]): ParsedCommandLine {
  // First pass: find the command words without knowing the command's own flags.
  const loose = parseArgs({ args: argv, options: GLOBAL_OPTIONS, strict: false, allowPositionals: true });
  const words = loose.positionals;
  let command: string | undefined;
  let consumed = 0;
  if (words[0] === "help") {
    return { command: undefined, positionals: words.slice(1), values: { help: true }, rest: [] };
  }
  if (words[0] && GROUPS.has(words[0])) {
    const fallback = DEFAULT_SUBCOMMAND[words[0]];
    if (words[1] && COMMANDS[`${words[0]} ${words[1]}`]) {
      command = `${words[0]} ${words[1]}`;
      consumed = 2;
    } else if (fallback) {
      command = `${words[0]} ${fallback}`;
      consumed = 1;
    } else if (!words[1]) {
      if (loose.values.help) return { command: undefined, positionals: [], values: { help: true }, rest: [] };
      throw new UsageError(`Missing subcommand: omb ${words[0]} <${subcommandsOf(words[0]).join("|")}>`);
    } else {
      command = `${words[0]} ${words[1]}`;
      consumed = 2;
    }
  } else if (words[0] && words[1] && OPTIONAL_GROUPS[words[0]]?.includes(words[1])) {
    command = `${words[0]} ${words[1]}`;
    consumed = 2;
  } else if (words[0]) {
    command = words[0];
    consumed = 1;
  }
  if (command && !COMMANDS[command]) throw new UsageError(`Unknown command: ${command}. Run omb --help.`);

  const options: Options = { ...GLOBAL_OPTIONS, ...(command ? COMMANDS[command]!.options : {}) };
  let args = argv;
  let rest: string[] = [];
  const dashes = argv.indexOf("--");
  if (command && TAKES_REST.has(command) && dashes >= 0) {
    args = argv.slice(0, dashes);
    rest = argv.slice(dashes + 1);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: expandOptionalValues(args, options), options: parseArgsOptions(options), strict: true, allowPositionals: true });
  } catch (err) {
    throw new UsageError((err as Error).message.replace(/^.*?Unknown option/, "Unknown option"));
  }
  // Drop the command words (they are the first positionals, in order).
  const positionals = parsed.positionals.slice(consumed);
  return { command, positionals, values: parsed.values as Values, rest };
}

export function subcommandsOf(group: string): string[] {
  return Object.keys(COMMANDS)
    .filter((k) => k.startsWith(`${group} `))
    .map((k) => k.slice(group.length + 1));
}

export function helpText(command?: string): string {
  if (command && COMMANDS[command]) {
    const spec = COMMANDS[command]!;
    return `Usage: omb ${spec.usage}\n\n${spec.summary}.\n\n${GLOBAL_HELP}`;
  }
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.split(" [")[0]!.split(" <")[0]!.length));
  const lines = Object.entries(COMMANDS).map(([, spec]) => {
    const head = spec.usage.split(" [")[0]!.split(" <")[0]!.split(" --")[0]!;
    return `  ${head.padEnd(width)}  ${spec.summary}`;
  });
  return `omb: read, post, wait and work tasks on an OpenMessageBoard.

Usage: omb <command> [args] [flags]

Commands:
${lines.join("\n")}

${GLOBAL_HELP}
Run omb <command> --help for a command's arguments.
Exit codes: 0 ok, 1 error, 2 timeout. tasks run exits with its command's code, 130 on Ctrl-C and 143 on SIGTERM.`;
}

const GLOBAL_HELP = `Global flags:
  --server <url>          Server URL (or OMB_SERVER, or the saved config)
  --as <profile>          Write as a profile, such as an agent's name (or OMB_PROFILE);
                          shown as "<profile> via <you>", with your access
  --account <name>        Use the token saved under this account (omb login --account)
  --oidc github|vercel    Use the deployment's OIDC identity instead of a stored token
  --json                  Print results as JSON
  -h, --help              Show help
`;

// ------------------------------------------------------------------ value helpers

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

export function list(values: Values, name: string): string[] {
  const v = values[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

export function flag(values: Values, name: string): boolean {
  return values[name] === true;
}

/** `k=v` pairs → labels. Keys follow the protocol's label key rules. */
export function parseLabels(pairs: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`Labels are key=value: ${pair}`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!LABEL_KEY_PATTERN.test(key)) throw new UsageError(`Invalid label key "${key}": use lowercase letters, digits, . _ - (up to 32)`);
    if (!value) throw new UsageError(`Label ${key} needs a value`);
    if (value.length > MAX_LABEL_VALUE) throw new UsageError(`Label ${key} is longer than ${MAX_LABEL_VALUE} characters`);
    labels[key] = value;
  }
  if (Object.keys(labels).length > MAX_LABELS) throw new UsageError(`At most ${MAX_LABELS} labels`);
  return labels;
}

const DURATION = /^(\d+)\s*(m|min|h|d|w)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** RFC 3339 time, or a duration from now such as 30m, 12h, 7d, 2w. Returns an ISO instant. */
export function parseTime(input: string, now: Date = new Date()): string {
  const d = DURATION.exec(input.trim());
  if (d) return new Date(now.getTime() + Number(d[1]) * UNIT_MS[d[2]!.toLowerCase()]!).toISOString();
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new UsageError(`Not a time: ${input} (use RFC 3339 like 2026-12-01T17:00:00Z, or a duration like 7d)`);
  return new Date(ms).toISOString();
}

const SECONDS = /^(\d+)\s*(s|sec|m|min|h|d|w)?$/i;
const UNIT_S: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86_400, w: 604_800 };

/** A duration such as 90s, 30m, 1h, 1d or 2w (a bare number is seconds), in seconds. */
export function parseDurationSeconds(input: string, name: string): number {
  const m = SECONDS.exec(input.trim());
  if (!m || Number(m[1]) < 1) throw new UsageError(`${name} is a duration such as 30m, 1h or 24h`);
  return Number(m[1]) * UNIT_S[(m[2] ?? "s").toLowerCase()]!;
}

export function parsePositiveInt(input: string, name: string): number {
  if (!/^\d+$/.test(input) || Number(input) < 1) throw new UsageError(`${name} must be a positive whole number`);
  return Number(input);
}

/** Accepts a bare ID or a board/thread URL (`…/b/<board>` or `…/b/<board>/t/<thread>`). */
export function boardIdFrom(input: string): string {
  const m = /\/b\/([A-Za-z0-9_-]+)/.exec(input);
  return m ? m[1]! : input.trim();
}

export function threadIdFrom(input: string): string {
  const m = /\/b\/[A-Za-z0-9_-]+\/t\/([A-Za-z0-9_-]+)/.exec(input);
  return m ? m[1]! : input.trim();
}

export function isThreadUrl(input: string): boolean {
  return /\/b\/[A-Za-z0-9_-]+\/t\/[A-Za-z0-9_-]+/.test(input);
}

/**
 * Whether an optional first argument names a board rather than a channel: a board URL, or an ID starting with `b_`.
 * Anything else that is a valid channel path (or a subtree ending in `/`) is a channel.
 */
export function isBoardArg(input: string): boolean {
  return /\/b\/[A-Za-z0-9_-]+/.test(input) || input.startsWith("b_") || !CHANNEL_FILTER_PATTERN.test(input);
}

/** `pattern=perms` pairs → a grant's `can`. Perms are a comma list, `all` or `none`. */
export function parseCan(pairs: string[]): GrantCanInput {
  if (pairs.length === 0) throw new UsageError("Pass at least one --can 'pattern=perms', such as --can 'security/=all'");
  const can: GrantCanInput = {};
  for (const pair of pairs) {
    const eq = pair.lastIndexOf("=");
    if (eq <= 0) throw new UsageError(`--can is pattern=perms, got "${pair}"`);
    const pattern = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!GRANT_PATTERN_PATTERN.test(pattern)) throw new UsageError(`"${pattern}" is not '*', a channel, or a subtree ending in '/'`);
    if (value === "all" || value === "none") {
      can[pattern] = value;
      continue;
    }
    const perms = value.split(",").map((p) => p.trim()).filter(Boolean);
    const bad = perms.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (bad.length || perms.length === 0) throw new UsageError(`Permissions are all, none, or a comma list of ${PERMISSIONS.join(", ")}; got "${value}"`);
    can[pattern] = perms as Permission[];
  }
  return can;
}

/** Splits `[board] a b` style positionals: returns the optional board and the required rest. */
export function splitOptionalBoard(positionals: string[], required: number, usage: string): { board: string | undefined; rest: string[] } {
  if (positionals.length === required) return { board: undefined, rest: positionals };
  if (positionals.length === required + 1) return { board: boardIdFrom(positionals[0]!), rest: positionals.slice(1) };
  throw new UsageError(`Usage: omb ${usage}`);
}

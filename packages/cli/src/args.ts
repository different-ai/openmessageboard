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

type OptionSpec = { type: "string" | "boolean"; short?: string; multiple?: boolean };
export type Options = Record<string, OptionSpec>;
export type Values = Record<string, string | boolean | string[] | undefined>;

export const GLOBAL_OPTIONS = {
  server: { type: "string" },
  as: { type: "string" },
  json: { type: "boolean" },
  oidc: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies Options;

const label = { type: "string", multiple: true } as const;

export interface CommandSpec {
  usage: string;
  summary: string;
  options?: Options;
}

/** Every command, keyed by its words ("tasks claim"). */
export const COMMANDS: Record<string, CommandSpec> = {
  login: { usage: "login --server <url> [--token <t>] [--as <profile>]", summary: "Save a personal access token or agent token", options: { token: { type: "string" } } },
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
    usage: "read [board|channel|channel/] [--board <id>] [--channel <c>] [--thread <id>] [--unread] [--label k=v] [--limit n]",
    summary: "List threads (in a channel, or a subtree with a trailing /), or read one thread",
    options: { thread: { type: "string" }, unread: { type: "boolean" }, label, limit: { type: "string" }, board: { type: "string" }, channel: { type: "string" } },
  },
  post: {
    usage: "post [board|channel] <title> <body|-> [--board <id>] [--channel <c>] [--task] [--label k=v ...] [--mention <principal-id> ...]",
    summary: "Start a thread, in general unless a channel is given (- reads the body from stdin)",
    options: { task: { type: "boolean" }, label, mention: { type: "string", multiple: true }, board: { type: "string" }, channel: { type: "string" } },
  },
  reply: {
    usage: "reply <thread> <body|-> [--mention <principal-id> ...] [--reply-to <message>]",
    summary: "Reply in a thread",
    options: { mention: { type: "string", multiple: true }, "reply-to": { type: "string" } },
  },
  delete: { usage: "delete <message>", summary: "Delete a message (leaves a tombstone)" },
  wait: {
    usage: "wait [--thread <id> | --mentions | --board <id>] [--timeout <s>]",
    summary: "Block until activity arrives (exit 0), or time out (exit 2)",
    options: { thread: { type: "string" }, mentions: { type: "boolean" }, board: { type: "string" }, timeout: { type: "string" } },
  },
  tail: { usage: "tail [board] [--thread <id> | --inbox]", summary: "Stream changes live", options: { thread: { type: "string" }, inbox: { type: "boolean" } } },
  inbox: { usage: "inbox [--unread] [--mark-read]", summary: "Mentions, replies in threads you follow, tasks assigned to you", options: { unread: { type: "boolean" }, "mark-read": { type: "boolean" } } },
  "tasks list": {
    usage: "tasks list [board] [--state open|claimed|done|cancelled] [--label k=v] [--mine]",
    summary: "List tasks",
    options: { state: { type: "string" }, label, mine: { type: "boolean" } },
  },
  "tasks create": {
    usage: "tasks create [board|channel] <title> <body|-> [--board <id>] [--channel <c>] [--label k=v ...]",
    summary: "Create a task",
    options: { label, mention: { type: "string", multiple: true }, board: { type: "string" }, channel: { type: "string" } },
  },
  "tasks claim": {
    usage: "tasks claim [<thread>] [--ready] [--board <id>] [--label k=v ...]",
    summary: "Claim a task, or the oldest open task matching labels",
    options: { ready: { type: "boolean" }, board: { type: "string" }, label },
  },
  "tasks complete": { usage: "tasks complete <thread> [--result <text|->]", summary: "Complete a task, optionally posting a result", options: { result: { type: "string" } } },
  "tasks release": { usage: "tasks release <thread>", summary: "Give a claimed task back" },
  "tasks cancel": { usage: "tasks cancel <thread>", summary: "Cancel a task" },
  "tasks reopen": { usage: "tasks reopen <thread>", summary: "Reopen a done or cancelled task" },
  label: { usage: "label <thread> k=v ... [--remove k ...]", summary: "Set or remove thread labels", options: { remove: { type: "string", multiple: true } } },
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
}

const GROUPS = new Set(["tasks", "boards", "channels", "grants"]);
/** Groups that run a default subcommand when the next word isn't one of theirs (`omb channels b_1` lists). */
const DEFAULT_SUBCOMMAND: Record<string, string> = { boards: "list", channels: "list", grants: "list" };

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
    return { command: undefined, positionals: words.slice(1), values: { help: true } };
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
      if (loose.values.help) return { command: undefined, positionals: [], values: { help: true } };
      throw new UsageError(`Missing subcommand: omb ${words[0]} <${subcommandsOf(words[0]).join("|")}>`);
    } else {
      command = `${words[0]} ${words[1]}`;
      consumed = 2;
    }
  } else if (words[0]) {
    command = words[0];
    consumed = 1;
  }
  if (command && !COMMANDS[command]) throw new UsageError(`Unknown command: ${command}. Run omb --help.`);

  const options: Options = { ...GLOBAL_OPTIONS, ...(command ? COMMANDS[command]!.options : {}) };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (err) {
    throw new UsageError((err as Error).message.replace(/^.*?Unknown option/, "Unknown option"));
  }
  // Drop the command words (they are the first positionals, in order).
  const positionals = parsed.positionals.slice(consumed);
  return { command, positionals, values: parsed.values as Values };
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
Exit codes: 0 ok, 1 error, 2 timeout.`;
}

const GLOBAL_HELP = `Global flags:
  --server <url>          Server URL (or OMB_SERVER, or the saved config)
  --as <profile>          Act with the token saved under this profile (e.g. an agent's)
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

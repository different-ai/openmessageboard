import { OmbError, isOmbError } from "@openmessageboard/sdk";
import { UsageError, helpText, parseCommandLine, type Values } from "./args.js";
import { CLI_VERSION, Context, RUNNERS } from "./commands.js";
import type { Io } from "./io.js";

/** Commands whose standard output is always one JSON document (spec 13 §Output). */
const JSON_COMMANDS = new Set(["call", "tools"]);

/**
 * Runs one `omb` invocation and returns the exit status (spec 13 §Exit status):
 * 0 ok, 1 error, 2 nothing happened in the time allowed (a timeout, or `no_task_available`).
 */
export async function main(argv: string[], io: Io): Promise<number> {
  let values: Values = {};
  let ctx: Context | undefined;
  // Known before parsing, so that a usage error from `call` or `tools` is JSON too.
  let json = JSON_COMMANDS.has(argv.find((a) => !a.startsWith("-")) ?? "") || argv.includes("--json");
  try {
    // A bearer token never belongs on the command line (spec 13 §Configuration). Refuse it before parsing,
    // so that no later message echoes it. `tasks ... --token` is a claim's token, which is not a credential.
    const first = argv.find((a) => !a.startsWith("-"));
    if (first !== "tasks" && argv.some((a) => a === "--token" || a.startsWith("--token="))) {
      throw new UsageError("omb does not take a token as an argument, where other processes can read it. Set OMB_TOKEN, or save one with omb login (pasted, or piped on standard input).");
    }
    const parsed = parseCommandLine(argv);
    values = parsed.values;
    json = values.json === true || JSON_COMMANDS.has(parsed.command ?? "");
    if (values.version) {
      io.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (!parsed.command || values.help) {
      io.stdout.write(`${helpText(parsed.command ?? parsed.positionals.join(" "))}\n`);
      return parsed.command || values.help ? 0 : 1;
    }
    ctx = new Context(io, values);
    const code = await RUNNERS[parsed.command]!(ctx, parsed.positionals, values, parsed.rest);
    return code ?? 0;
  } catch (err) {
    reportError(err, io, json);
    return isOmbError(err) && err.code === "no_task_available" ? 2 : 1;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

/**
 * Reports a failure. In JSON mode the error result goes to standard output as `{"error": ErrorBody}`,
 * the shape a tool error has over MCP, so that standard output is one JSON document on every path.
 */
export function reportError(err: unknown, io: Io, json: boolean): void {
  if (err instanceof UsageError) {
    if (json) io.stdout.write(`${JSON.stringify({ error: { code: "invalid_argument", message: err.message } })}\n`);
    else io.stderr.write(`omb: ${err.message}\n`);
    return;
  }
  const e = isOmbError(err) ? err : new OmbError("internal", err instanceof Error ? err.message : String(err));
  if (json) {
    io.stdout.write(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } })}\n`);
    return;
  }
  let line = `omb: ${e.code}: ${e.message}`;
  const d = e.details ?? {};
  if (e.code === "quota_exceeded" && d.limit !== undefined) line += ` (${d.allowance}: ${d.used}/${d.limit}, resets ${d.resets_at ?? "never"})`;
  if (e.code === "rate_limited" && typeof d.retry_after_ms === "number") line += ` (retry in ${Math.ceil(d.retry_after_ms / 1000)}s)`;
  if (e.code === "invite_not_eligible" && d.reason) line += ` (${d.reason})`;
  io.stderr.write(`${line}\n`);
}

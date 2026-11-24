import { OmbError, isOmbError } from "@openmessageboard/sdk";
import { UsageError, helpText, parseCommandLine, type Values } from "./args.js";
import { CLI_VERSION, Context, RUNNERS } from "./commands.js";
import type { Io } from "./io.js";

/** Runs one `omb` invocation and returns the exit code: 0 ok, 1 error, 2 timeout. */
export async function main(argv: string[], io: Io): Promise<number> {
  let values: Values = {};
  let ctx: Context | undefined;
  try {
    const parsed = parseCommandLine(argv);
    values = parsed.values;
    if (values.version) {
      io.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (!parsed.command || values.help) {
      io.stdout.write(`${helpText(parsed.command ?? parsed.positionals.join(" "))}\n`);
      return parsed.command || values.help ? 0 : 1;
    }
    ctx = new Context(io, values);
    const code = await RUNNERS[parsed.command]!(ctx, parsed.positionals, values);
    return code ?? 0;
  } catch (err) {
    reportError(err, io, values.json === true);
    return 1;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

export function reportError(err: unknown, io: Io, json: boolean): void {
  if (err instanceof UsageError) {
    if (json) io.stderr.write(`${JSON.stringify({ error: { code: "invalid_argument", message: err.message } })}\n`);
    else io.stderr.write(`omb: ${err.message}\n`);
    return;
  }
  const e = isOmbError(err) ? err : new OmbError("internal", err instanceof Error ? err.message : String(err));
  if (json) {
    io.stderr.write(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } })}\n`);
    return;
  }
  let line = `omb: ${e.code}: ${e.message}`;
  const d = e.details ?? {};
  if (e.code === "quota_exceeded" && d.limit !== undefined) line += ` (${d.allowance}: ${d.used}/${d.limit}, resets ${d.resets_at ?? "never"})`;
  if (e.code === "rate_limited" && typeof d.retry_after_ms === "number") line += ` (retry in ${Math.ceil(d.retry_after_ms / 1000)}s)`;
  if (e.code === "invite_not_eligible" && d.reason) line += ` (${d.reason})`;
  io.stderr.write(`${line}\n`);
}

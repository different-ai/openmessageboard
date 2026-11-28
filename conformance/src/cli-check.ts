/**
 * Checks a command-line client against the CLI profile (spec/v0.2/13-command-line-clients.md)
 * by running it against a conforming server:
 *
 *   tsx --conditions=source src/cli-check.ts --exec "omb" \
 *     --url http://localhost:8787 --identities conformance/identities.json
 *
 * `--exec` is the command that starts the CLI, split on spaces. The checks act as the
 * identities file's `outsider` and write a few threads on that person's own board.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SPEC_VERSION, ServerInfo } from "@openmessageboard/protocol";
import { CLI_CASES } from "./cli-profile/cases.ts";
import { CliCtx, runCliCases, type CliResult } from "./cli-profile/harness.ts";
import { loadIdentities } from "./identities.ts";
import { McpSession } from "./mcp.ts";

const USAGE = `omb-conformance cli: check a command-line client against the CLI profile

  --exec <command>      how to start the CLI, for example "omb" or "node dist/index.js" (required)
  --url <url>           server base URL (default: "server" in the identities file)
  --identities <file>   identities file (required)
  --only <ids>          comma-separated case ids or prefixes
  --json-out <file>     write the JSON report to a file
  --list                list the cases and exit`;

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      exec: { type: "string" },
      url: { type: "string" },
      identities: { type: "string" },
      only: { type: "string", default: "" },
      "json-out": { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.list) {
    for (const c of CLI_CASES) console.log(`${c.id.padEnd(28)} ${c.title}`);
    return 0;
  }
  if (!args.exec || !args.identities) {
    console.error(`--exec and --identities are required\n\n${USAGE}`);
    return 2;
  }
  const identities = loadIdentities(args.identities);
  const url = (args.url ?? identities.server ?? "").replace(/\/+$/, "");
  if (!url) {
    console.error('--url is required when the identities file has no "server"');
    return 2;
  }
  const info = ServerInfo.parse(await (await fetch(`${url}/.well-known/openmessageboard`)).json());
  const mcp = await McpSession.connect("outsider", info.mcp_endpoint, identities.principals.outsider.token);
  const ctx = new CliCtx(args.exec.split(/\s+/).filter(Boolean), url, info, identities, mcp);
  const only = args.only.split(",").map((s) => s.trim()).filter(Boolean);
  const cases = only.length ? CLI_CASES.filter((c) => only.some((o) => c.id === o || c.id.startsWith(o))) : CLI_CASES;
  console.log(`omb-conformance cli: checking "${args.exec}" against ${url}, run ${ctx.runId}\n`);
  const label = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  const started = Date.now();
  let results: CliResult[];
  try {
    results = await runCliCases(ctx, cases, (r) => {
      console.log(`${label[r.status]}  ${r.id.padEnd(28)} ${r.title} (${(r.duration_ms / 1000).toFixed(1)} s)`);
      if (r.reason) console.log(`      ${r.status === "fail" ? "reason" : "why"}: ${r.reason}`);
      if (r.status === "fail" && r.covers.length) console.log(`      requirements: ${r.covers.join(", ")} (spec/v${SPEC_VERSION}/requirements.md)`);
    });
  } finally {
    await ctx.close();
  }
  const summary = { pass: results.filter((r) => r.status === "pass").length, fail: results.filter((r) => r.status === "fail").length, skip: results.filter((r) => r.status === "skip").length };
  console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (args["json-out"]) {
    writeFileSync(args["json-out"], `${JSON.stringify({ runner: "omb-conformance cli", spec_version: SPEC_VERSION, cli: args.exec, server: url, started_at: new Date(started).toISOString(), summary, results }, null, 2)}\n`);
  }
  return summary.fail > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);

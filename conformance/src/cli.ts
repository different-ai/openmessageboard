#!/usr/bin/env node
/**
 * omb-conformance: checks an OpenMessageBoard server against spec v0.2 using only
 * its public interface (MCP over HTTP with bearer tokens, the discovery document,
 * invite URLs, and a local webhook receiver).
 *
 *   tsx --conditions=source conformance/src/cli.ts --url http://localhost:8787 \
 *     --identities conformance/identities.json --profiles core,live,events,tasks,automation,import,public
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROFILES, SPEC_VERSION } from "@openmessageboard/protocol";
import type { Profile } from "@openmessageboard/protocol";
import { ALL_CASES } from "./cases/index.ts";
import { Ctx, runCases } from "./harness.ts";
import { loadIdentities } from "./identities.ts";
import { rateLimitWaits } from "./mcp.ts";
import { formatReport, formatResult, type Report } from "./report.ts";

const VERSION = "0.1.0";
const USAGE = `usage: omb-conformance --identities <file> [--url <server>] [options]

  --url <url>             server base URL (default: "server" in the identities file)
  --identities <file>     identities JSON (see conformance/README.md)
  --profiles <list>       comma-separated profiles to test (default: core,live,events,tasks,automation,import,public)
  --only <ids>            comma-separated case ids or prefixes (e.g. core.invite,live.)
  --force-profiles        run profiles the server does not claim
  --json                  print the machine-readable report on stdout
  --json-out <file>       also write the JSON report to a file
  --verbose               show notes for passing cases
  --list                  list cases and exit
  -h, --help              show this help`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        url: { type: "string" },
        identities: { type: "string" },
        profiles: { type: "string", default: "core,live,events,tasks,automation,import,public" },
        only: { type: "string", default: "" },
        "force-profiles": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "json-out": { type: "string" },
        verbose: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const profiles = args.profiles.split(",").map((p) => p.trim()).filter(Boolean);
  const unknown = profiles.filter((p) => !(PROFILES as readonly string[]).includes(p));
  if (unknown.length) {
    console.error(`unknown profile(s): ${unknown.join(", ")}; known: ${PROFILES.join(", ")}`);
    return 2;
  }
  if (args.list) {
    for (const c of ALL_CASES) if (profiles.includes(c.profile)) console.log(`${c.id.padEnd(36)} ${c.title}`);
    return 0;
  }
  if (!args.identities) {
    console.error(`--identities is required\n\n${USAGE}`);
    return 2;
  }
  let identities;
  try {
    identities = loadIdentities(args.identities);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const url = args.url ?? identities.server;
  if (!url) {
    console.error("--url is required when the identities file has no \"server\"");
    return 2;
  }
  const log = (s: string) => (args.json ? process.stderr : process.stdout).write(s + "\n");
  const started = Date.now();
  const ctx = new Ctx({
    url,
    identities,
    profiles: profiles as Profile[],
    only: args.only.split(",").map((s) => s.trim()).filter(Boolean),
    forceProfiles: args["force-profiles"],
    onResult: (r) => log(formatResult(r, args.verbose)),
  });
  log(`omb-conformance ${VERSION}: testing ${url} (${profiles.join(", ")}), run ${ctx.runId}\n`);
  let results;
  try {
    results = await runCases(ctx, ALL_CASES);
  } finally {
    await ctx.close();
  }
  const report: Report = {
    runner: { name: "omb-conformance", version: VERSION },
    spec_version: SPEC_VERSION,
    server: { url, implementation: ctx.info?.implementation ?? null, profiles_claimed: ctx.info?.profiles ?? [] },
    profiles_tested: profiles,
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    results,
  };
  if (rateLimitWaits) log(`note: waited out ${rateLimitWaits} rate_limited response(s); raise OMB_RATE_* limits for faster runs`);
  log("\n" + formatReport(report));
  const json = JSON.stringify(report, null, 2);
  if (args["json-out"]) writeFileSync(args["json-out"], json + "\n");
  if (args.json) process.stdout.write(json + "\n");
  return report.summary.fail > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    // Lingering keep-alive sockets or listen streams must not hold the process open.
    setTimeout(() => process.exit(code), 500).unref();
  },
  (e: unknown) => {
    console.error(`omb-conformance crashed: ${(e as Error)?.stack ?? String(e)}`);
    process.exit(2);
  },
);

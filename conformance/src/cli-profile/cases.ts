/**
 * The CLI profile (spec/v0.2/13-command-line-clients.md): checks that drive an executable
 * from outside, against a conforming server. Nothing here imports the CLI under test.
 */
import { check } from "../errors.ts";
import type { CliCase, CliCtx } from "./harness.ts";

const jsonOf = (ctx: CliCtx, r: { stdout: string }, what: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    check(false, `${what}: standard output is not JSON: ${r.stdout.slice(0, 200)}`);
  }
  check(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${what}: standard output is not a JSON object`);
  void ctx;
  return parsed as Record<string, unknown>;
};

const errorCode = (body: Record<string, unknown>): unknown => (body.error as { code?: unknown } | undefined)?.code;

export const CLI_CASES: CliCase[] = [
  {
    id: "cli.tools",
    title: "tools prints the server's tool list as JSON",
    covers: ["R13-05"],
    async run(ctx) {
      const r = await ctx.run(["tools"]);
      check(r.code === 0, `tools exited ${r.code}: ${r.stderr.slice(0, 200)}`);
      const listed = jsonOf(ctx, r, "tools").tools;
      check(Array.isArray(listed), "tools did not print an object with a tools array");
      const names = (listed as { name?: unknown }[]).map((t) => t.name);
      const expected = (await ctx.mcp.client.listTools()).tools.map((t) => t.name);
      check(JSON.stringify(names) === JSON.stringify(expected), `tools printed ${names.length} tools, in a different order or set than tools/list returned (${expected.length})`);
      check((listed as { inputSchema?: unknown }[]).every((t) => t.inputSchema && typeof t.inputSchema === "object"), "a listed tool has no inputSchema");
    },
  },
  {
    id: "cli.call-result",
    title: "call prints the tool's structuredContent, reads OMB_SERVER and OMB_TOKEN, and exits 0",
    covers: ["R13-02", "R13-09", "R13-12"],
    async run(ctx) {
      const r = await ctx.run(["call", "whoami"]);
      check(r.code === 0, `call whoami exited ${r.code}: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
      const printed = jsonOf(ctx, r, "call whoami");
      const direct = await ctx.mcp.ok("whoami", {});
      const principal = printed.principal as { id?: unknown; kind?: unknown } | undefined;
      const server = printed.server as { mcp_endpoint?: unknown; spec_version?: unknown; limits?: unknown } | undefined;
      check(principal?.id === direct.principal.id && principal?.kind === direct.principal.kind, "call whoami printed a different principal than an MCP client receives");
      check(server?.mcp_endpoint === direct.server.mcp_endpoint && server?.spec_version === direct.server.spec_version, "call whoami printed a different server object than an MCP client receives");
      check(JSON.stringify(server?.limits) === JSON.stringify(direct.server.limits), "call whoami did not print the result's nested objects unchanged (server.limits differs)");
      check((printed.owned_board as { id?: unknown } | null | undefined)?.id === direct.owned_board?.id, "call whoami printed a different owned_board than an MCP client receives");
    },
  },
  {
    id: "cli.call-input",
    title: "call takes its arguments inline, from a file and from standard input, and rejects what is not an object",
    covers: ["R13-03"],
    async run(ctx) {
      const args = JSON.stringify({ unread_only: true });
      const inline = await ctx.run(["call", "get_inbox", "--input", args]);
      const fromFile = await ctx.run(["call", "get_inbox", "--input", `@${ctx.writeTemp("args.json", args)}`]);
      const fromStdin = await ctx.run(["call", "get_inbox", "--input", "-"], { stdin: args });
      for (const [how, r] of [["inline", inline], ["a file", fromFile], ["standard input", fromStdin]] as const) {
        check(r.code === 0, `call with arguments from ${how} exited ${r.code}: ${r.stdout.slice(0, 200)}`);
        check(Array.isArray(jsonOf(ctx, r, `call (${how})`).items), `call with arguments from ${how} did not print get_inbox's result`);
      }
      const bad = await ctx.run(["call", "get_inbox", "--input", "[1,2]"]);
      check(bad.code === 1, `arguments that are not a JSON object must be a usage error (exit 1), got ${bad.code}`);
      check(errorCode(jsonOf(ctx, bad, "call with an array")) !== undefined, "a usage error from call must still print {error} as JSON");
    },
  },
  {
    id: "cli.call-error",
    title: "A failed tool call prints {error} with the tool's code on standard output and exits 1",
    covers: ["R13-07", "R13-09"],
    async run(ctx) {
      const r = await ctx.run(["call", "get_thread", "--input", JSON.stringify({ thread_id: `t_cli_unknown_${ctx.runId}` })]);
      check(r.code === 1, `a failed call must exit 1, got ${r.code}`);
      check(errorCode(jsonOf(ctx, r, "failed call")) === "not_found", `the error code must be the tool's (not_found), got ${JSON.stringify(errorCode(jsonOf(ctx, r, "failed call")))}`);
    },
  },
  {
    id: "cli.exit-no-task",
    title: "A tool that answers no_task_available exits 2",
    covers: ["R13-09"],
    async run(ctx) {
      if (!ctx.claims("tasks")) ctx.skip('server does not claim the "tasks" profile');
      const r = await ctx.run(["call", "claim_task", "--input", JSON.stringify({ board_id: await ctx.board(), labels: { "cli-check": ctx.runId } })]);
      check(r.code === 2, `no_task_available must exit 2, got ${r.code}: ${r.stdout.slice(0, 200)}`);
      check(errorCode(jsonOf(ctx, r, "claim_task")) === "no_task_available", "the error printed must be no_task_available");
    },
  },
  {
    id: "cli.wait-timeout",
    title: "wait on a quiet board exits 2 when its timeout passes, printing an empty page with --json",
    covers: ["R13-09", "R13-10"],
    timeoutMs: 60_000,
    async run(ctx) {
      const cursor = (await ctx.mcp.ok("get_changes", { board_id: await ctx.board() })).cursor;
      const started = Date.now();
      const r = await ctx.run(["wait", "--board", await ctx.board(), "--after", cursor, "--timeout", "2", "--json"], { timeoutMs: 45_000 });
      check(r.code === 2, `a wait that times out must exit 2, got ${r.code}: ${r.stderr.slice(0, 200)}`);
      check(Date.now() - started >= 1500, "wait returned before its timeout with nothing to report");
      const page = jsonOf(ctx, r, "wait (timeout)");
      check(Array.isArray(page.changes) && page.changes.length === 0, "a timed-out wait must print an object with no changes");
    },
  },
  {
    id: "cli.wait-activity",
    title: "wait returns the changes after a cursor, with a cursor to continue from, and exits 0",
    covers: ["R13-10", "R13-11"],
    timeoutMs: 60_000,
    async run(ctx) {
      const board = await ctx.board();
      const cursor = (await ctx.mcp.ok("get_changes", { board_id: board })).cursor;
      const other = await ctx.otherMember();
      const t = await other.ok("start_thread", { board_id: board, title: `CLI wait ${ctx.runId}`, body: "Something to notice.", idempotency_key: `cliwait-${ctx.runId}` });
      const r = await ctx.run(["wait", "--board", board, "--after", cursor, "--timeout", "20", "--json"], { timeoutMs: 45_000 });
      check(r.code === 0, `wait must exit 0 when there is activity, got ${r.code}: ${r.stderr.slice(0, 200)}`);
      const page = jsonOf(ctx, r, "wait");
      check(Array.isArray(page.changes) && page.changes.some((c) => (c as { thread_id?: string }).thread_id === t.thread.id), "wait did not print the change that followed the cursor");
      check(typeof page.cursor === "string" && page.cursor.length > 0, "wait must print a cursor to continue from");
    },
  },
  {
    id: "cli.profile",
    title: "OMB_PROFILE names the profile to write as, and --as overrides it",
    covers: ["R13-12", "R13-13"],
    async run(ctx) {
      const fromEnv = await ctx.run(["call", "whoami"], { env: { OMB_PROFILE: "cli-env" } });
      check(fromEnv.code === 0, `call whoami with OMB_PROFILE exited ${fromEnv.code}: ${fromEnv.stdout.slice(0, 200)}`);
      check((jsonOf(ctx, fromEnv, "whoami").principal as { profile?: unknown }).profile === "cli-env", "with OMB_PROFILE set, whoami must answer as that profile");
      const fromFlag = await ctx.run(["call", "whoami", "--as", "cli-flag"], { env: { OMB_PROFILE: "cli-env" } });
      check(fromFlag.code === 0, `call whoami --as exited ${fromFlag.code}: ${fromFlag.stdout.slice(0, 200)}`);
      check((jsonOf(ctx, fromFlag, "whoami --as").principal as { profile?: unknown }).profile === "cli-flag", "--as must override OMB_PROFILE");
    },
  },
  {
    id: "cli.idempotency",
    title: "call supplies an idempotency key when given none, a new one each time, and sends the caller's key unchanged",
    covers: ["R13-17", "R13-19", "R13-20"],
    async run(ctx) {
      const board = await ctx.board();
      const base = { board_id: board, title: `CLI key ${ctx.runId}`, body: "Posted by the CLI check." };
      const first = await ctx.run(["call", "start_thread", "--input", JSON.stringify(base)]);
      const second = await ctx.run(["call", "start_thread", "--input", JSON.stringify(base)]);
      check(first.code === 0 && second.code === 0, `start_thread without a key must succeed (the CLI supplies one): exits ${first.code}, ${second.code}: ${first.stdout.slice(0, 200)}`);
      const id = (r: { stdout: string }) => (jsonOf(ctx, r, "start_thread").thread as { id?: string } | undefined)?.id;
      check(id(first) && id(second) && id(first) !== id(second), "two invocations without a key must create two threads: a generated key is never reused");
      const keyed = { ...base, title: `CLI keyed ${ctx.runId}`, idempotency_key: `clikey-${ctx.runId}` };
      const a = await ctx.run(["call", "start_thread", "--input", JSON.stringify(keyed)]);
      const b = await ctx.run(["call", "start_thread", "--input", JSON.stringify(keyed)]);
      check(a.code === 0 && b.code === 0, `start_thread with the caller's key must succeed twice: exits ${a.code}, ${b.code}`);
      check(id(a) !== undefined && id(a) === id(b), "repeating an invocation with the same key must return the same thread: the caller's key is sent unchanged");
    },
  },
  {
    id: "cli.no-token-argument",
    title: "A token given as a command-line argument is refused",
    covers: ["R13-14"],
    async run(ctx) {
      for (const args of [
        ["call", "whoami", "--token", ctx.token],
        ["--token", ctx.token, "call", "whoami"],
        ["call", "whoami", `--token=${ctx.token}`],
      ]) {
        const r = await ctx.run(args, { withoutToken: true });
        check(r.code !== 0, `the CLI accepted a token as an argument (${args.map((a) => (a === ctx.token ? "<token>" : a.replace(ctx.token, "<token>"))).join(" ")})`);
      }
    },
  },
  {
    id: "cli.stdout-json",
    title: "Standard output of call, tools and --json commands was one JSON document and a newline, on success and on failure",
    covers: ["R13-06"],
    async run(ctx) {
      const bad = ctx.recorded.filter((r) => r.jsonMode && !r.expectAnyOutput).filter((r) => {
        if (!r.stdout.endsWith("\n")) return true;
        try {
          JSON.parse(r.stdout);
          return false;
        } catch {
          return true;
        }
      });
      check(bad.length === 0, `${bad.length} run(s) printed something other than one JSON document: ${bad.map((r) => `[${r.args.slice(0, 2).join(" ")}] ${JSON.stringify(r.stdout.slice(0, 80))}`).join("; ")}`);
      check(ctx.recorded.some((r) => r.jsonMode && r.code !== 0), "no failing JSON-mode run was recorded; run the whole suite");
    },
  },
  {
    id: "cli.no-token-in-output",
    title: "No run printed the token",
    covers: ["R13-15"],
    async run(ctx) {
      const leaked = ctx.recorded.filter((r) => r.stdout.includes(ctx.token) || r.stderr.includes(ctx.token));
      check(leaked.length === 0, `${leaked.length} run(s) printed the bearer token: ${leaked.map((r) => r.args[0]).join(", ")}`);
    },
  },
];

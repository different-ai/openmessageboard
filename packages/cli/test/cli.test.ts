import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { Change, Message, Thread, Usage } from "@openmessageboard/sdk";
import { UsageError, boardIdFrom, helpText, parseCommandLine, parseDurationSeconds, parseLabels, parseTime, splitOptionalBoard, threadIdFrom } from "../src/args.ts";
import { forgetClaim, loadClaim, saveClaim } from "../src/claims.ts";
import { parsePlan } from "../src/tasks.ts";
import { configPath, readConfig, resolveConnection, writeConfig } from "../src/config.ts";
import { authorName, formatChange, formatMessage, formatTable, formatTasks, formatUsage, relativeTime } from "../src/format.ts";
import type { Io } from "../src/io.ts";
import { main } from "../src/main.ts";
import { FakeServer, ToolError } from "../../sdk/test/fake-server.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const maya = { id: "p_maya", kind: "human" as const, display_name: "Maya", via: null };
const agent = { id: "p_rel", kind: "agent" as const, display_name: "release-agent", via: { id: "p_maya", display_name: "Maya" } };

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m_1",
    board_id: "b_1",
    thread_id: "t_1",
    author: agent,
    body: "Build 812 is green.\nShipping at 3pm.",
    deleted: false,
    reply_to: null,
    mentions: [],
    source: null,
    created_at: "2026-11-23T11:55:00Z",
    ...over,
  };
}

function task(id: string, state: "ready" | "claimed" | "completed" | "waiting", title: string, labels: Record<string, string> = {}): Thread {
  return {
    id,
    board_id: "b_1",
    url: `https://board.example.com/b/b_1/t/${id}`,
    title,
    kind: "task",
    labels,
    task: {
      state,
      owner: maya,
      for: null,
      assignee: state === "ready" || state === "waiting" ? null : agent,
      claimed_at: null,
      lease_until: state === "claimed" ? "2026-11-23T12:04:00Z" : null,
      completed_at: null,
      needs: state === "waiting" ? [{ thread_id: "t_1", title: "Fix", state: "ready" }] : [],
      result: null,
      failure_reason: null,
      blocked_reason: null,
      blocked_kind: null,
      canceled_reason: null,
    },
    created_by: maya,
    created_at: "2026-11-23T10:00:00Z",
    last_activity_at: "2026-11-23T10:00:00Z",
    message_count: 1,
    following: true,
    unread_count: 0,
    links: [],
  };
}

describe("argument parsing", () => {
  it("finds the command with global flags anywhere", () => {
    const p = parseCommandLine(["--server", "https://board.example.com", "read", "b_1", "--unread", "--json"]);
    assert.equal(p.command, "read");
    assert.deepEqual(p.positionals, ["b_1"]);
    assert.equal(p.values.server, "https://board.example.com");
    assert.equal(p.values.unread, true);
    assert.equal(p.values.json, true);
  });

  it("parses post with repeated labels and mentions, and - for stdin", () => {
    const p = parseCommandLine(["post", "Release 1.4", "-", "--label", "area=ios", "--label", "state=review", "--mention", "p_omar", "--as", "release-agent", "--task"]);
    assert.equal(p.command, "post");
    assert.deepEqual(p.positionals, ["Release 1.4", "-"]);
    assert.deepEqual(p.values.label, ["area=ios", "state=review"]);
    assert.deepEqual(p.values.mention, ["p_omar"]);
    assert.equal(p.values.as, "release-agent");
    assert.equal(p.values.task, true);
  });

  it("parses task subcommands", () => {
    const claim = parseCommandLine(["tasks", "claim", "--ready", "--board", "b_1", "--label", "area=ios"]);
    assert.equal(claim.command, "tasks claim");
    assert.deepEqual(claim.positionals, []);
    assert.equal(claim.values.ready, true);
    const done = parseCommandLine(["tasks", "complete", "t_9", "--result", "-"]);
    assert.equal(done.command, "tasks complete");
    assert.deepEqual(done.positionals, ["t_9"]);
    assert.equal(done.values.result, "-");
    const bare = parseCommandLine(["tasks", "b_1", "--state", "all"]);
    assert.equal(bare.command, "tasks list");
    assert.deepEqual(bare.positionals, ["b_1"]);
    assert.equal(parseCommandLine(["tasks"]).command, "tasks list");
    const run = parseCommandLine(["tasks", "run", "--ready", "--label", "step=test", "--wait", "10m", "--", "npm", "test", "--", "--watch=false"]);
    assert.equal(run.command, "tasks run");
    assert.deepEqual(run.positionals, []);
    assert.deepEqual(run.rest, ["npm", "test", "--", "--watch=false"]);
    assert.equal(run.values.wait, "10m");
    const reply = parseCommandLine(["reply", "t_1", "--", "-1 looks wrong"]);
    assert.deepEqual(reply.positionals, ["t_1", "-1 looks wrong"], "only tasks run splits at --");
  });

  it("parses wait durations and plans", () => {
    assert.equal(parseDurationSeconds("10m", "--wait"), 600);
    assert.equal(parseDurationSeconds("90", "--wait"), 90);
    assert.equal(parseDurationSeconds("1h", "--wait"), 3600);
    assert.throws(() => parseDurationSeconds("soon", "--wait"), UsageError);
    const plan = parsePlan(JSON.stringify([{ key: "fix", title: "Fix", body: "fix it" }, { title: "Review", body: "review", needs: [{ key: "fix" }, "t_9"], for: "p_rel" }]));
    assert.equal(plan.length, 2);
    assert.throws(() => parsePlan(JSON.stringify([{ title: "Fix", body: "x", need: [{ key: "a" }] }])), /unknown key "need"/);
    assert.throws(() => parsePlan(JSON.stringify([{ title: "Fix" }])), /needs a body/);
    assert.throws(() => parsePlan(JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ title: `T${i}`, body: "x" })))), /1-15 tasks/);
    assert.throws(() => parsePlan("{"), /not valid JSON/);
  });

  it("parses wait and invite flags", () => {
    const w = parseCommandLine(["wait", "--mentions", "--timeout", "30", "--oidc", "github"]);
    assert.equal(w.command, "wait");
    assert.equal(w.values.mentions, true);
    assert.equal(w.values.timeout, "30");
    assert.equal(w.values.oidc, "github");
    const i = parseCommandLine(["invite", "--email", "omar@example.test", "--role", "contributor", "--access-ends", "7d"]);
    assert.equal(i.values.email, "omar@example.test");
    assert.equal(i.values["access-ends"], "7d");
  });

  it("rejects unknown commands and flags", () => {
    assert.throws(() => parseCommandLine(["frobnicate"]), UsageError);
    assert.throws(() => parseCommandLine(["read", "--nope"]), UsageError);
    assert.throws(() => parseCommandLine(["reply", "--task"]), UsageError, "--task belongs to post");
  });

  it("treats help as help", () => {
    assert.equal(parseCommandLine(["help"]).values.help, true);
    assert.equal(parseCommandLine(["tasks", "claim", "-h"]).values.help, true);
    assert.match(helpText(), /tasks claim/);
    assert.match(helpText("tasks claim"), /Usage: omb tasks claim <thread> \| tasks claim --ready/);
  });

  it("parses labels with the protocol's key rules", () => {
    assert.deepEqual(parseLabels(["area=ios", "state=in review", "url=a=b"]), { area: "ios", state: "in review", url: "a=b" });
    assert.throws(() => parseLabels(["noequals"]), UsageError);
    assert.throws(() => parseLabels(["Bad Key=x"]), UsageError);
    assert.throws(() => parseLabels(["k="]), UsageError);
  });

  it("parses times and durations", () => {
    assert.equal(parseTime("7d", NOW), "2026-11-30T12:00:00.000Z");
    assert.equal(parseTime("90m", NOW), "2026-11-23T13:30:00.000Z");
    assert.equal(parseTime("2026-12-01T17:00:00Z", NOW), "2026-12-01T17:00:00.000Z");
    assert.throws(() => parseTime("next friday", NOW), UsageError);
  });

  it("accepts URLs where IDs are expected", () => {
    assert.equal(boardIdFrom("https://board.example.com/b/b_1"), "b_1");
    assert.equal(boardIdFrom("https://board.example.com/b/b_1/t/t_2"), "b_1");
    assert.equal(threadIdFrom("https://board.example.com/b/b_1/t/t_2"), "t_2");
    assert.equal(threadIdFrom("t_2"), "t_2");
  });

  it("splits an optional leading board", () => {
    assert.deepEqual(splitOptionalBoard(["Title", "Body"], 2, "post"), { board: undefined, rest: ["Title", "Body"] });
    assert.deepEqual(splitOptionalBoard(["b_1", "Title", "Body"], 2, "post"), { board: "b_1", rest: ["Title", "Body"] });
    assert.throws(() => splitOptionalBoard(["Title"], 2, "post"), UsageError);
  });
});

describe("claims", () => {
  it("stores a claim per task and server, mode 0600", () => {
    const path = configPath({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-claims-")) });
    const claim = { epoch: 2, token: "tok", until: "2026-11-23T12:05:00Z" };
    saveClaim(path, "https://board.example.com", "t_1", claim);
    assert.deepEqual(loadClaim(path, "https://board.example.com", "t_1"), { server: "https://board.example.com", thread_id: "t_1", ...claim });
    assert.equal(loadClaim(path, "https://other.example.com", "t_1"), undefined, "a claim belongs to its server");
    assert.equal(statSync(join(path, "..", "claims", "t_1.json")).mode & 0o777, 0o600);
    saveClaim(path, "https://board.example.com", "../escape", claim);
    assert.equal(loadClaim(path, "https://board.example.com", "../escape"), undefined, "unsafe IDs are never used as file names");
    forgetClaim(path, "t_1");
    assert.equal(loadClaim(path, "https://board.example.com", "t_1"), undefined);
  });
});

describe("config", () => {
  const config = { server: "https://board.example.com", profiles: { default: { token: "omb_person" }, "release-agent": { token: "omb_agent" } } };

  it("lives under XDG_CONFIG_HOME, else ~/.config", () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/openmessageboard/config.json");
    assert.equal(configPath({ HOME: "/home/maya" }), "/home/maya/.config/openmessageboard/config.json");
  });

  it("writes with mode 0600 and reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cli-"));
    const path = join(dir, "openmessageboard", "config.json");
    writeConfig(path, config);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readConfig(path), config);
    writeFileSync(path, "{nope");
    assert.throws(() => readConfig(path), /not valid JSON/);
    assert.deepEqual(readConfig(join(dir, "missing.json")), { profiles: {} });
  });

  it("resolves the server and credential in order", () => {
    assert.equal(resolveConnection({}, {}, config).token, "omb_person");
    assert.equal(resolveConnection({}, { OMB_TOKEN: "env" }, config).token, "env");
    assert.equal(resolveConnection({ as: "release-agent" }, { OMB_TOKEN: "env" }, config).token, "omb_agent", "--as beats OMB_TOKEN");
    assert.equal(resolveConnection({ server: "https://other.example.com/mcp" }, { OMB_SERVER: "https://env.example.com" }, config).server, "https://other.example.com");
    assert.equal(resolveConnection({}, { OMB_SERVER: "https://env.example.com" }, config).server, "https://env.example.com");
    const oidc = resolveConnection({ oidc: "github" }, {}, config);
    assert.equal(oidc.token, undefined);
    assert.equal(typeof oidc.tokenProvider, "function");
    assert.equal(oidc.source, "oidc:github");
    assert.throws(() => resolveConnection({ as: "nobody" }, {}, config), /omb login --as nobody/);
    assert.throws(() => resolveConnection({}, {}, { profiles: {} }), /No server configured/);
    assert.throws(() => resolveConnection({ oidc: "gitlab" }, {}, config), /github or vercel/);
  });
});

describe("formatting", () => {
  it("shows agents with the person they act for", () => {
    assert.equal(authorName(agent), "release-agent (via Maya)");
    assert.equal(authorName(maya), "Maya");
  });

  it("formats relative times", () => {
    assert.equal(relativeTime("2026-11-23T11:59:50Z", NOW), "just now");
    assert.equal(relativeTime("2026-11-23T11:55:00Z", NOW), "5m ago");
    assert.equal(relativeTime("2026-11-23T09:00:00Z", NOW), "3h ago");
    assert.equal(relativeTime("2026-11-21T12:00:00Z", NOW), "2d ago");
    assert.equal(relativeTime("2026-10-01T12:00:00Z", NOW), "2026-10-01");
  });

  it("formats a message as header then indented body", () => {
    assert.equal(formatMessage(message(), NOW), "release-agent (via Maya) · 5m ago · m_1\n  Build 812 is green.\n  Shipping at 3pm.");
    assert.equal(formatMessage(message({ deleted: true, body: null, author: maya }), NOW), "Maya · 5m ago · m_1\n  [deleted]");
  });

  it("formats tasks as a compact table", () => {
    const out = formatTasks([task("t_1", "ready", "Fix login crash", { area: "ios" }), task("t_22", "claimed", "Write release notes"), task("t_3", "waiting", "Ship")], NOW);
    assert.equal(
      out,
      [
        "ID    STATE       WHO                       NEEDS   LABELS    TITLE",
        "t_1   ready       -                         -       area=ios  Fix login crash",
        "t_22  claimed 4m  release-agent (via Maya)  -       -         Write release notes",
        "t_3   waiting     -                         1 open  -         Ship",
      ].join("\n"),
    );
    assert.equal(formatTasks([]), "No tasks.");
  });

  it("formats tables without trailing spaces", () => {
    assert.equal(formatTable(["A", "B"], [["x", ""]]), "A  B\nx");
  });

  it("formats changes for tail", () => {
    const change: Change = {
      seq: 7,
      type: "message.created",
      board_id: "b_1",
      thread_id: "t_1",
      message_id: "m_1",
      actor: agent,
      created_at: "2026-11-23T11:55:00Z",
      thread: null,
      message: message(),
      member: null,
    };
    assert.match(formatChange(change, NOW), /^t_1 release-agent \(via Maya\) · 5m ago · m_1\n {2}Build 812/);
    const claimed: Change = { ...change, type: "thread.updated", message: null, message_id: null, thread: task("t_1", "claimed", "Fix") };
    assert.equal(formatChange(claimed, NOW), "~ t_1 task claimed by release-agent (via Maya)");
  });

  it("formats usage with bytes and warnings", () => {
    const usage: Usage = {
      board_id: "b_1",
      allowances: [
        { allowance: "posts", used: 1700, limit: 2000, unit: "count", resets_at: "2026-12-01T00:00:00Z", warning: true },
        { allowance: "storage", used: 5 * 1024 * 1024, limit: 100 * 1024 * 1024, unit: "bytes", resets_at: null, warning: false },
      ],
      storage_formula: "UTF-8 bytes of live bodies and titles",
    };
    const out = formatUsage(usage);
    assert.match(out, /posts\s+1700\s+2000\s+2026-12-01T00:00:00Z\s+! 80%\+/);
    assert.match(out, /storage\s+5\.0 MiB\s+100 MiB/);
  });
});

describe("main (no network)", () => {
  function io(env: NodeJS.ProcessEnv = {}, stdin = "") {
    const out: string[] = [];
    const err: string[] = [];
    const value: Io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      stdin: Readable.from([stdin]) as unknown as Io["stdin"],
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-main-")), ...env },
    };
    return { value, out, err };
  }

  it("prints the version and help", async () => {
    const a = io();
    assert.equal(await main(["--version"], a.value), 0);
    assert.equal(a.out.join(""), "0.1.0\n");
    const b = io();
    assert.equal(await main(["--help"], b.value), 0);
    assert.match(b.out.join(""), /Exit codes: 0 ok, 1 error, 2 timeout/);
  });

  it("exits 1 with the error code on stderr", async () => {
    const a = io();
    assert.equal(await main(["read"], a.value), 1);
    assert.match(a.err.join(""), /^omb: invalid_argument: No server configured/);
    const b = io({ OMB_SERVER: "https://board.example.com" });
    assert.equal(await main(["whoami"], b.value), 1);
    assert.match(b.err.join(""), /^omb: unauthenticated: Not logged in/);
    const c = io();
    assert.equal(await main(["post", "only-a-title"], c.value), 1);
    assert.match(c.err.join(""), /Usage: omb post/);
  });

  it("reports errors as JSON with --json", async () => {
    const a = io({ OMB_SERVER: "https://board.example.com" });
    assert.equal(await main(["whoami", "--json"], a.value), 1);
    assert.equal(JSON.parse(a.err.join("")).error.code, "unauthenticated");
  });
});

describe("tasks run (against the SDK's fake server)", () => {
  let fake: FakeServer;
  let thread: Thread;
  let settled: Record<string, unknown>[];
  let renewals = 0;
  let leaseMs = 60_000;
  let renewFails = false;
  before(async () => {
    fake = await new FakeServer().start();
    thread = fake.addThread("Run the tests", undefined, "npm test", { task: true }).thread;
    fake.tools.claim_task = () => ({ thread, claim: { epoch: 1, token: "tok-run", until: new Date(Date.now() + leaseMs).toISOString() } });
    fake.tools.renew_task = (args) => {
      renewals++;
      assert.equal(args.token, "tok-run");
      if (renewFails) throw new ToolError("claim_lost", "This claim is over", { state: "ready" });
      return { thread, claim: { epoch: 1, token: "tok-run", until: new Date(Date.now() + leaseMs).toISOString() } };
    };
    fake.tools.update_task = (args) => {
      settled.push(args);
      return { thread, message: null };
    };
  });
  after(() => fake.stop());

  function io(signals: Map<string, () => void> = new Map()) {
    const out: string[] = [];
    const err: string[] = [];
    const value: Io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      stdin: Readable.from([""]) as unknown as Io["stdin"],
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-run-")), OMB_SERVER: fake.url, OMB_TOKEN: "good-token" },
      onSignal: (sig, handler) => {
        signals.set(sig, handler);
        return () => signals.delete(sig);
      },
      spawn: (cmd, args, env) => spawn(cmd, args, { stdio: "ignore", env }),
    };
    return { value, out, err };
  }
  const node = (code: string) => ["--", process.execPath, "-e", code];

  it("completes the task when the command exits 0, with OMB_TASK set and the claim forgotten", async () => {
    settled = [];
    leaseMs = 60_000;
    const a = io();
    const code = await main(["tasks", "run", thread.id, "--result", "tests pass", ...node(`process.exit(process.env.OMB_TASK === ${JSON.stringify(thread.id)} ? 0 : 9)`)], a.value);
    assert.equal(code, 0, a.err.join(""));
    assert.deepEqual(settled.map((s) => [s.action, s.token, s.result]), [["complete", "tok-run", "tests pass"]]);
    assert.match(a.out.join(""), new RegExp(`Completed ${thread.id}`));
    assert.equal(loadClaim(configPath(a.value.env), fake.url, thread.id), undefined);
  });

  it("fails the task with the exit code otherwise", async () => {
    settled = [];
    const a = io();
    assert.equal(await main(["tasks", "run", thread.id, ...node("process.exit(3)")], a.value), 3);
    assert.deepEqual(settled.map((s) => [s.action, s.reason]), [["fail", "the command exited with code 3"]]);
  });

  it("renews at a third of the lease and stops the command when the claim is lost", async () => {
    settled = [];
    renewals = 0;
    leaseMs = 1500;
    renewFails = true;
    const a = io();
    const started = Date.now();
    assert.equal(await main(["tasks", "run", thread.id, ...node("setTimeout(() => {}, 20000)")], a.value), 1);
    assert.ok(Date.now() - started < 5000, "the command was stopped");
    assert.equal(renewals, 1);
    assert.deepEqual(settled, [], "a lost claim settles nothing");
    assert.match(a.err.join(""), /claim_lost/);
    renewFails = false;
  });

  it("releases the task on SIGTERM and exits 143", async () => {
    settled = [];
    leaseMs = 60_000;
    const signals = new Map<string, () => void>();
    const a = io(signals);
    const running = main(["tasks", "run", thread.id, ...node("process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 20000)")], a.value);
    for (let i = 0; i < 100 && !signals.has("SIGTERM"); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    signals.get("SIGTERM")!();
    assert.equal(await running, 143);
    assert.deepEqual(settled.map((s) => s.action), ["release"]);
  });

  it("asks for the command after --", async () => {
    const a = io();
    assert.equal(await main(["tasks", "run", thread.id], a.value), 1);
    assert.match(a.err.join(""), /Pass the command after --/);
  });
});

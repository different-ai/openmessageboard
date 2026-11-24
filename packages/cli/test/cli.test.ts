import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { Change, Message, Thread, Usage } from "@openmessageboard/sdk";
import { UsageError, boardIdFrom, helpText, isBoardArg, parseCan, parseCommandLine, parseLabels, parseTime, splitOptionalBoard, threadIdFrom } from "../src/args.ts";
import { configPath, readConfig, resolveConnection, writeConfig } from "../src/config.ts";
import { authorName, formatAccess, formatChange, formatChannels, formatGrants, formatMessage, formatTable, formatTasks, formatUsage, relativeTime } from "../src/format.ts";
import type { Io } from "../src/io.ts";
import { main } from "../src/main.ts";

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

function task(id: string, state: "open" | "claimed" | "done", title: string, labels: Record<string, string> = {}): Thread {
  return {
    id,
    board_id: "b_1",
    channel: "general",
    url: `https://board.example.com/b/b_1/t/${id}`,
    title,
    kind: "task",
    labels,
    task: { state, assignee: state === "open" ? null : agent, claimed_at: null, completed_at: null },
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
  it("parses channel, grant and board groups, with list as the default subcommand", () => {
    assert.equal(parseCommandLine(["channels"]).command, "channels list");
    const listOn = parseCommandLine(["channels", "b_1"]);
    assert.equal(listOn.command, "channels list");
    assert.deepEqual(listOn.positionals, ["b_1"]);
    const create = parseCommandLine(["channels", "create", "security", "--private"]);
    assert.equal(create.command, "channels create");
    assert.deepEqual(create.positionals, ["security"]);
    assert.equal(create.values.private, true);
    assert.equal(parseCommandLine(["boards"]).command, "boards list");
    assert.deepEqual(parseCommandLine(["boards", "create", "Security"]).positionals, ["Security"]);
    const g = parseCommandLine(["grants", "create", "--member", "@omar", "--everyone", "--can", "security/=all", "--can", "*=read,post"]);
    assert.equal(g.command, "grants create");
    assert.deepEqual(g.values.can, ["security/=all", "*=read,post"]);
    assert.equal(parseCommandLine(["grants", "explain", "security/incidents", "--member", "p_omar"]).command, "grants explain");
  });

  it("tells boards from channels and parses --can", () => {
    assert.equal(isBoardArg("b_1"), true);
    assert.equal(isBoardArg("https://board.example.com/b/b_8f2k1"), true);
    assert.equal(isBoardArg("dev"), false);
    assert.equal(isBoardArg("www/"), false);
    assert.equal(isBoardArg("www/production"), false);
    assert.equal(isBoardArg("NotAChannel"), true);
    assert.deepEqual(parseCan(["security/=all", "*=read, post", "ops=none"]), { "security/": "all", "*": ["read", "post"], ops: "none" });
    assert.throws(() => parseCan(["security/=fly"]), UsageError);
    assert.throws(() => parseCan(["Bad=all"]), UsageError);
    assert.throws(() => parseCan([]), UsageError);
  });

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
    assert.throws(() => parseCommandLine(["tasks"]), /Missing subcommand/);
    assert.throws(() => parseCommandLine(["reply", "--task"]), UsageError, "--task belongs to post");
  });

  it("treats help as help", () => {
    assert.equal(parseCommandLine(["help"]).values.help, true);
    assert.equal(parseCommandLine(["tasks", "claim", "-h"]).values.help, true);
    assert.match(helpText(), /tasks claim/);
    assert.match(helpText("tasks claim"), /Usage: omb tasks claim \[<thread>\] \[--ready\]/);
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
  it("formats channels, grants and access explanations", () => {
    const out = formatChannels(
      [
        { board_id: "b_1", path: "general", thread_count: 3, last_activity_at: "2026-11-23T11:55:00Z", private: false, my_permissions: ["read", "post"], created_at: "2026-11-01T00:00:00Z" },
        { board_id: "b_1", path: "security", thread_count: 0, last_activity_at: null, private: true, my_permissions: ["read", "post", "react", "label", "manage"], created_at: "2026-11-01T00:00:00Z" },
      ],
      NOW,
    );
    assert.match(out, /general\s+3\s+5m ago\s+read,post/);
    assert.match(out, /security\s+0\s+-\s+read,post,react,label,manage\s+private/);
    const grants = formatGrants(
      [
        {
          id: "g_1",
          board_id: "b_1",
          principals: [{ kind: "member", principal_id: "p_maya" }, { kind: "everyone" }],
          can: { "security/": [], "*": ["read"] },
          created_by: maya,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
        },
      ],
      [{ principal: maya, role: "contributor", joined_at: "2026-11-01T00:00:00Z", access_ends_at: null, handle: "maya" }],
    );
    assert.match(grants, /g_1\s+@maya, everyone\s+security\/=none \*=read/);
    const why = formatAccess({
      board_id: "b_1",
      channel: "security/incidents",
      principal: agent,
      role: "contributor",
      can: [],
      pattern: "security/",
      level: "everyone",
      grant_ids: ["g_2"],
      granted: [],
      role_cap: ["read", "post", "react", "label", "manage"],
      person_cap: [],
    });
    assert.match(why, /release-agent \(via Maya\) \(contributor\) in security\/incidents: nothing/);
    assert.match(why, /Decided by g_2 at security\/ \(everyone\)/);
  });

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
    const out = formatTasks([task("t_1", "open", "Fix login crash", { area: "ios" }), task("t_22", "claimed", "Write release notes")]);
    assert.equal(
      out,
      [
        "ID    STATE    ASSIGNEE                  LABELS    TITLE",
        "t_1   open     -                         area=ios  Fix login crash",
        "t_22  claimed  release-agent (via Maya)  -         Write release notes",
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

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile, ServerInfo } from "@openmessageboard/protocol";
import { Failure, Skip } from "../errors.ts";
import type { Identities } from "../identities.ts";
import { McpSession } from "../mcp.ts";

export interface CliRun {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
  /** The command's standard output is meant to be one JSON document (call, tools, or --json). */
  jsonMode: boolean;
  expectAnyOutput: boolean;
}

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Run without OMB_TOKEN in the environment. */
  withoutToken?: boolean;
}

export interface CliCase {
  id: string;
  title: string;
  /** Requirement IDs (spec/v0.2/requirements.json) a failing CLI would fail this case on. */
  covers: string[];
  placeholder?: boolean;
  timeoutMs?: number;
  run(ctx: CliCtx): Promise<void>;
}

export interface CliResult {
  id: string;
  title: string;
  covers: string[];
  status: "pass" | "fail" | "skip";
  reason?: string;
  duration_ms: number;
}

/** Drives one executable against one server, as one human who owns a board. */
export class CliCtx {
  readonly runId = randomBytes(3).toString("hex");
  readonly recorded: CliRun[] = [];
  readonly token: string;
  private readonly home = mkdtempSync(join(tmpdir(), "omb-cli-check-"));
  private boardId: Promise<string> | undefined;
  private other: Promise<McpSession> | undefined;

  constructor(
    private readonly exec: string[],
    readonly url: string,
    readonly info: ServerInfo,
    private readonly identities: Identities,
    /** An MCP session as the same principal the CLI runs as. */
    readonly mcp: McpSession,
  ) {
    this.token = identities.principals.outsider.token;
  }

  claims(profile: Profile): boolean {
    return this.info.profiles.includes(profile);
  }

  skip(reason: string): never {
    throw new Skip(reason);
  }

  writeTemp(name: string, contents: string): string {
    const path = join(this.home, name);
    writeFileSync(path, contents);
    return path;
  }

  /** The board the CLI's principal owns (created by its first whoami). */
  board(): Promise<string> {
    this.boardId ??= this.mcp.ok("whoami", {}).then((me) => {
      if (!me.owned_board) throw new Failure("the CLI check's principal has no board of its own");
      return me.owned_board.id;
    });
    return this.boardId;
  }

  /** A second human, joined to that board as a contributor, to write what the CLI waits for. */
  otherMember(): Promise<McpSession> {
    this.other ??= (async () => {
      const board = await this.board();
      const session = await McpSession.connect("subdomain", this.info.mcp_endpoint, this.identities.principals.subdomain.token);
      const me = await session.ok("whoami", {});
      if (!me.memberships.some((m) => m.board_id === board)) {
        const invite = await this.mcp.ok("create_invite", { board_id: board, audience: "link", role: "contributor" });
        if (!invite.invite.url) throw new Failure("create_invite returned no url");
        await session.ok("redeem_invite", { invite: invite.invite.url });
      }
      return session;
    })();
    return this.other;
  }

  run(args: string[], opts: RunOptions = {}): Promise<CliRun> {
    const [command, ...prefix] = this.exec;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, "config"),
      OMB_SERVER: this.url,
      ...(opts.withoutToken ? {} : { OMB_TOKEN: this.token }),
      ...opts.env,
    };
    return new Promise((resolve, reject) => {
      const child = spawn(command!, [...prefix, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Failure(`the CLI did not exit within ${(opts.timeoutMs ?? 30_000) / 1000} s: ${args.slice(0, 3).join(" ")}`));
      }, opts.timeoutMs ?? 30_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Failure(`cannot start the CLI (${command}): ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const first = args.find((a) => !a.startsWith("-"));
        const run: CliRun = {
          args,
          code: code ?? -1,
          stdout,
          stderr,
          jsonMode: first === "call" || first === "tools" || args.includes("--json"),
          // A refused token argument may fail before the CLI knows which command it was given.
          expectAnyOutput: opts.withoutToken === true,
        };
        this.recorded.push(run);
        resolve(run);
      });
      child.stdin.end(opts.stdin ?? "");
    });
  }

  async close(): Promise<void> {
    await this.mcp.close().catch(() => undefined);
    if (this.other) await (await this.other).close().catch(() => undefined);
  }
}

export async function runCliCases(ctx: CliCtx, cases: CliCase[], onResult?: (r: CliResult) => void): Promise<CliResult[]> {
  const results: CliResult[] = [];
  for (const c of cases) {
    const started = Date.now();
    let status: CliResult["status"] = "pass";
    let reason: string | undefined;
    try {
      await Promise.race([
        c.run(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Failure(`timed out after ${(c.timeoutMs ?? 120_000) / 1000} s`)), c.timeoutMs ?? 120_000).unref()),
      ]);
    } catch (err) {
      if (err instanceof Skip) {
        status = "skip";
        reason = err.message;
      } else {
        status = "fail";
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    const r: CliResult = { id: c.id, title: c.title, covers: c.covers, status, reason, duration_ms: Date.now() - started };
    results.push(r);
    onResult?.(r);
  }
  return results;
}

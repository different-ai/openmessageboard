import { randomBytes } from "node:crypto";
import { ServerInfo as ServerInfoSchema } from "@openmessageboard/protocol";
import type { Profile, ServerInfo, ToolOutput } from "@openmessageboard/protocol";
import { Failure, Skip } from "./errors.ts";
import { httpRequest } from "./http.ts";
import type { Identities, PrincipalName } from "./identities.ts";
import { McpSession, writePacing } from "./mcp.ts";
import { describeError } from "./util.ts";
import { WebhookReceiver } from "./webhook.ts";

export type Status = "pass" | "fail" | "skip";

export interface CaseDef {
  id: string;
  profile: Profile;
  title: string;
  /** Per-case timeout; default 120 s. */
  timeoutMs?: number;
  run(ctx: Ctx): Promise<void>;
}

export interface CaseResult {
  id: string;
  profile: Profile;
  title: string;
  status: Status;
  reason?: string;
  notes: string[];
  duration_ms: number;
}

export interface RunOptions {
  url: string;
  identities: Identities;
  profiles: Profile[];
  only: string[];
  forceProfiles: boolean;
  onResult?: (r: CaseResult) => void;
}

export interface Me {
  id: string;
  ownedBoard: string | null;
  whoami: ToolOutput<"whoami">;
}

export class Ctx {
  readonly runId = randomBytes(3).toString("hex");
  readonly url: string;
  info: ServerInfo | undefined;
  /** Server clock minus local clock, from the discovery response's Date header. */
  skewMs = 0;
  private notesSink: string[] = [];
  private sessions = new Map<string, Promise<McpSession>>();
  private fixtures = new Map<string, Promise<unknown>>();
  private receiverPromise: Promise<WebhookReceiver> | undefined;
  readonly cleanups: (() => Promise<void>)[] = [];

  constructor(readonly opts: RunOptions) {
    this.url = opts.url.replace(/\/+$/, "");
  }

  get endpoint(): string {
    return this.info?.mcp_endpoint ?? `${this.url}/mcp`;
  }

  serverNow(): number {
    return Date.now() + this.skewMs;
  }

  isoIn(ms: number): string {
    return new Date(this.serverNow() + ms).toISOString();
  }

  note(message: string): void {
    this.notesSink.push(message);
  }

  /** @internal */
  beginCase(): string[] {
    this.notesSink = [];
    return this.notesSink;
  }

  skip(reason: string): never {
    throw new Skip(reason);
  }

  claims(profile: Profile): boolean {
    return this.info?.profiles.includes(profile) ?? false;
  }

  token(name: PrincipalName): string {
    return this.opts.identities.principals[name].token;
  }

  email(name: Exclude<PrincipalName, "agent">): string {
    return this.opts.identities.principals[name].email;
  }

  /** One shared MCP connection per principal. */
  session(name: PrincipalName): Promise<McpSession> {
    let s = this.sessions.get(name);
    if (!s) {
      s = this.discovery().then(() => McpSession.connect(name, this.endpoint, this.token(name)));
      this.sessions.set(name, s);
      s.catch(() => this.sessions.delete(name));
    }
    return s;
  }

  /** A fresh, unshared MCP connection (closed at the end of the run). */
  async freshSession(name: PrincipalName): Promise<McpSession> {
    await this.discovery();
    const s = await McpSession.connect(`${name}*`, this.endpoint, this.token(name));
    this.cleanups.push(() => s.close());
    return s;
  }

  /**
   * Memoized setup step shared by several cases. When it fails, every case that
   * needs it is skipped as blocked (the case that owns the behaviour reports the failure).
   */
  async fixture<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.fixtures.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.fixtures.set(key, p);
    }
    try {
      return await p;
    } catch (e) {
      if (e instanceof Skip) throw e;
      throw new Skip(`blocked: setup "${key}" failed: ${describeError(e)}`);
    }
  }

  /** Fetches and validates the discovery document once. */
  discovery(): Promise<ServerInfo> {
    return this.fixture("discovery", async () => {
      const res = await httpRequest(`${this.url}/.well-known/openmessageboard`).catch((e: unknown) => {
        throw new Failure(`GET ${this.url}/.well-known/openmessageboard failed: ${describeError(e)}`);
      });
      if (res.status !== 200) throw new Failure(`GET /.well-known/openmessageboard returned HTTP ${res.status}`);
      const parsed = ServerInfoSchema.safeParse(res.json);
      if (!parsed.success) {
        throw new Failure(`discovery document does not match ServerInfo: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const date = res.headers.get("date");
      if (date) {
        const server = Date.parse(date);
        if (Number.isFinite(server)) this.skewMs = server + 500 - Date.now();
      }
      this.info = parsed.data;
      writePacing.perMinute = parsed.data.rate_limits.writes_per_minute_principal ?? 0;
      return parsed.data;
    });
  }

  /** The principal's ID and owned board (from its first whoami, memoized). */
  me(name: PrincipalName): Promise<Me> {
    return this.fixture(`whoami:${name}`, async () => {
      const s = await this.session(name);
      const w = await s.ok("whoami", {});
      return { id: w.principal.id, ownedBoard: w.owned_board?.id ?? null, whoami: w };
    });
  }

  /** The caller's effective limits: whoami.principal.limits (plans), else ServerInfo.limits. */
  async limitsOf(name: PrincipalName): Promise<Record<string, number>> {
    const w = (await this.me(name)).whoami;
    return { ...w.server.limits, ...(w.principal.limits ?? {}) };
  }

  async boardOf(name: Exclude<PrincipalName, "agent">): Promise<string> {
    const me = await this.me(name);
    if (!me.ownedBoard) throw new Failure(`${name}: whoami returned no owned_board for a human`);
    return me.ownedBoard;
  }

  /** Base URL for resource URIs, taken from the server's own board URL. */
  async resourceBase(): Promise<string> {
    const me = await this.me("owner");
    const url = me.whoami.owned_board?.url;
    const id = me.whoami.owned_board?.id;
    if (url && id && url.endsWith(`/b/${id}`)) return url.slice(0, -`/b/${id}`.length);
    return this.info?.web_url.replace(/\/+$/, "") ?? this.url;
  }

  /** Whether `name` currently has an active membership on `boardId` (fresh whoami). */
  async isMember(name: PrincipalName, boardId: string): Promise<boolean> {
    const s = await this.session(name);
    const w = await s.ok("whoami", {});
    return w.memberships.some((m) => m.board_id === boardId);
  }

  receiver(): Promise<WebhookReceiver> {
    if (!this.receiverPromise) {
      this.receiverPromise = WebhookReceiver.start();
      this.cleanups.push(async () => (await this.receiverPromise)?.stop());
    }
    return this.receiverPromise;
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) await s.then((x) => x.close()).catch(() => {});
    for (const c of this.cleanups.reverse()) await c().catch(() => {});
  }
}

export async function runCases(ctx: Ctx, cases: CaseDef[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (!ctx.opts.profiles.includes(c.profile)) continue;
    if (ctx.opts.only.length && !ctx.opts.only.some((o) => c.id === o || c.id.startsWith(o.endsWith(".") ? o : `${o}.`) || c.id.includes(o))) continue;
    const notes = ctx.beginCase();
    const started = Date.now();
    let status: Status = "pass";
    let reason: string | undefined;
    try {
      if (c.profile !== "core" && !ctx.opts.forceProfiles) {
        const info = await ctx.discovery().catch(() => undefined);
        if (info && !info.profiles.includes(c.profile)) throw new Skip(`server does not claim the "${c.profile}" profile (use --force-profiles to run anyway)`);
      }
      const timeoutMs = c.timeoutMs ?? 120_000;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        c.run(ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Failure(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (e) {
      if (e instanceof Skip) {
        status = "skip";
        reason = e.message;
      } else {
        status = "fail";
        reason = describeError(e);
      }
    }
    const r: CaseResult = { id: c.id, profile: c.profile, title: c.title, status, reason, notes: [...notes], duration_ms: Date.now() - started };
    results.push(r);
    ctx.opts.onResult?.(r);
  }
  return results;
}

import { DurableObject } from "cloudflare:workers";
import { createMailer } from "./mailer.js";
import type { Booted } from "@openmessageboard/core";
import { DurableSqlite } from "./sqlite.js";
import { stringVars, type Env } from "./env.js";

/**
 * The core is loaded with a dynamic import. Better Auth loads some of its modules dynamically, which makes esbuild
 * wrap their dependencies (Zod among them) in lazy initializers; importing the core the same way keeps the whole
 * graph initializing in dependency order (a static import runs the MCP SDK's top-level Zod schemas too early).
 */
const loadCore = () =>
  Promise.all([import("@openmessageboard/core"), import("./platform.js"), import("./migrations.js"), import("@openmessageboard/core/domain/test-identities")]);

/** How long an idle object may sleep before checking for work that isn't in the due-time tables. */
const IDLE_WAKE_MS = 5 * 60_000;

/**
 * The board server: one Durable Object runs the whole core against its own SQLite database, like the Node process
 * does with a SQLite file. Requests, SSE streams and MCP calls are served while it's awake; an alarm wakes it for
 * the next delivery retry, scheduled post, lease or access expiry.
 */
export class BoardServer extends DurableObject<Env> {
  private booted: Booted | null = null;
  private mintTestIdentities: ((ctx: Booted["ctx"]) => unknown) | null = null;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const [{ bootServer, loadConfig, migrate, createOutboxMailer }, { cloudflarePlatform }, { CLOUDFLARE_MIGRATIONS }, { mintTestIdentities }] = await loadCore();
      this.mintTestIdentities = mintTestIdentities;
      const sqlite = new DurableSqlite(ctx.storage);
      const db = sqlite.asDb();
      await migrate(db, CLOUDFLARE_MIGRATIONS);
      const config = loadConfig(stringVars(env), { dataDir: "/durable-object", dbPath: "durable-object" });
      this.booted = await bootServer({ config, db, platform: cloudflarePlatform(env, sqlite), mailer: createMailer(env, createOutboxMailer) });
      this.booted.start();
      await this.scheduleWake();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    const booted = this.booted!;
    const url = new URL(request.url);
    if (url.pathname === "/x/test/identities" && request.method === "POST") return this.testIdentities(request);
    const response = await booted.app.fetch(request);
    this.ctx.waitUntil(this.scheduleWake());
    return response;
  }

  override async alarm(): Promise<void> {
    await this.ready;
    await this.booted!.tick();
    await this.scheduleWake();
  }

  /** Sets the alarm for the earliest due work, or a slow heartbeat when nothing is due. */
  private async scheduleWake(): Promise<void> {
    const next = this.booted?.nextWakeAt();
    const now = Date.now();
    const at = Math.max(now + 1000, Math.min(next ? next.getTime() : Infinity, now + IDLE_WAKE_MS));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current < now) await this.ctx.storage.setAlarm(at);
  }

  /** Test mode only: mints the conformance identities (the Node implementation's `omb admin test-identities`). */
  private testIdentities(request: Request): Response {
    const ctx = this.booted!.ctx;
    const token = this.env.OMB_TEST_ADMIN_TOKEN;
    if (!ctx.config.testMode || !token || token.length < 16 || request.headers.get("authorization") !== `Bearer ${token}`) {
      return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    }
    return Response.json(this.mintTestIdentities!(ctx));
  }
}

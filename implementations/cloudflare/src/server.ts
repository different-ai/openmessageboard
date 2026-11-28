import { DurableObject } from "cloudflare:workers";
import { createMailer } from "./mailer.js";
import { newsletterExtension } from "./newsletter.js";
import { doorwayEnabled, doorwayExtension } from "./doorway.js";
import { namesExtension, namesOptions, type NamesExtension } from "./names.js";
import { lifecycleSettings, type BoardSnapshot, type LifecycleSettings } from "./lifecycle.js";
import { boardSnapshot, deactivateIfInactive, isSynced, lifecycleExtension, markSynced, recordSignIns, unsyncedBoards } from "./lifecycle-server.js";
import type { BoardLifecycle } from "./lifecycle-object.js";
import type { Booted, ExtensionModule, Mailer } from "@openmessageboard/core";
import { DurableSqlite } from "./sqlite.js";
import { stringVars, type Env } from "./env.js";

/**
 * The core is loaded with a dynamic import. Better Auth loads some of its modules dynamically, which makes esbuild
 * wrap their dependencies (Zod among them) in lazy initializers; importing the core the same way keeps the whole
 * graph initializing in dependency order (a static import runs the MCP SDK's top-level Zod schemas too early).
 */
const loadCore = () =>
  Promise.all([
    import("@openmessageboard/core"),
    import("./platform.js"),
    import("./migrations.js"),
    import("@openmessageboard/core/domain/test-identities"),
    import("@openmessageboard/core/domain/access"),
    import("@openmessageboard/core/errors"),
    import("@openmessageboard/core/domain/invites"),
    import("@openmessageboard/core/domain/portability"),
    import("@openmessageboard/core/domain/plans"),
  ]);

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
  private names: NamesExtension | null = null;
  private readonly ready: Promise<void>;
  /** Board lifecycles (the `openmessageboard.cloudflare/lifecycle` extension): null when the operator left it off. */
  private readonly lifecycle: LifecycleSettings | null;
  /** True until one pass has introduced every board to its lifecycle object (after a start, or a nudge that failed). */
  private lifecycleBacklog = true;
  /** Boards that appeared since: introduced one by one, without another pass. */
  private readonly lifecycleNew = new Set<string>();
  private syncing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = env.LIFECYCLE ? lifecycleSettings(env) : null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const [{ bootServer, loadConfig, migrate, createOutboxMailer }, { cloudflarePlatform }, { CLOUDFLARE_MIGRATIONS }, { mintTestIdentities }, { requireMember }, { notFound }, { previewInvite }, { exportBoard }, { limitsFor }] = await loadCore();
      this.mintTestIdentities = mintTestIdentities;
      const sqlite = new DurableSqlite(ctx.storage);
      const db = sqlite.asDb();
      await migrate(db, CLOUDFLARE_MIGRATIONS);
      const config = loadConfig(stringVars(env), { dataDir: "/durable-object", dbPath: "durable-object" });
      // Extensions are off unless their binding or variable is set, so a plain deployment offers none.
      let mailer: Mailer | null = null;
      const mail = createMailer(env, createOutboxMailer);
      const nameRules = namesOptions(stringVars(env));
      if (nameRules) this.names = namesExtension(nameRules, { requireMember: requireMember as never, notFound: () => notFound("Board"), mailer: () => mailer });
      const extensions: ExtensionModule[] = [...(env.NEWSLETTER ? [newsletterExtension(env.NEWSLETTER)] : []), ...(this.names ? [this.names] : []), ...(doorwayEnabled(stringVars(env)) ? [doorwayExtension({ previewInvite, requireMember: requireMember as never })] : [])];
      if (this.lifecycle) extensions.push(lifecycleExtension({ settings: this.lifecycle, core: { exportBoard, limitsFor }, nudge: (boardId) => this.nudgeLifecycle(boardId) }));
      this.booted = await bootServer({ config, db, platform: cloudflarePlatform(env, sqlite), mailer: (ctx) => (mailer = mail(ctx)), features: { extensions } });
      this.booted.start();
      // A new board starts with its owner joining it: that is when its lifecycle object first hears of it.
      if (this.lifecycle) this.booted.ctx.hub.subscribe((e) => void (e.kind === "board" && e.type === "member.joined" && e.actorId === e.subjectId && this.lifecycleNew.add(e.boardId)));
      await this.scheduleWake();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    const booted = this.booted!;
    const url = new URL(request.url);
    if (url.pathname === "/x/test/identities" && request.method === "POST") return this.testIdentities(request);
    const response = await booted.app.fetch(request);
    if (this.lifecycle) {
      // The owner signing in is activity. The session row is the record; this keeps it after the session is gone.
      if (request.method === "POST" && (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/sign-in/")) && response.ok) recordSignIns(booted.ctx);
      if (this.lifecycleBacklog || this.lifecycleNew.size) this.ctx.waitUntil(this.syncLifecycles());
    }
    this.ctx.waitUntil(this.scheduleWake());
    return response;
  }

  override async alarm(): Promise<void> {
    await this.ready;
    await this.booted!.tick();
    await this.names?.sweep(this.booted!.ctx);
    if (this.lifecycle && (this.lifecycleBacklog || this.lifecycleNew.size)) await this.syncLifecycles();
    await this.scheduleWake();
  }

  // ---------- board lifecycles: called by each board's lifecycle object (lifecycle-object.ts) ----------

  async lifecycleSnapshot(boardId: string): Promise<BoardSnapshot> {
    await this.ready;
    return boardSnapshot(this.booted!.ctx, boardId);
  }

  async lifecycleDeactivate(boardId: string): Promise<BoardSnapshot> {
    await this.ready;
    const ctx = this.booted!.ctx;
    return this.lifecycle ? deactivateIfInactive(ctx, this.lifecycle, boardId) : boardSnapshot(ctx, boardId);
  }

  /** Tells one board's lifecycle object what is true now, so it sets its own Alarm. */
  private async nudgeLifecycle(boardId: string): Promise<void> {
    if (!this.lifecycle || !this.env.LIFECYCLE) return;
    const ctx = this.booted!.ctx;
    const ns = this.env.LIFECYCLE as unknown as DurableObjectNamespace<BoardLifecycle>;
    try {
      await ns.get(ns.idFromName(boardId)).sync(boardSnapshot(ctx, boardId));
      markSynced(ctx, boardId, this.lifecycle.fingerprint);
    } catch (e) {
      // The board stays marked, and the next pass tries again.
      this.lifecycleBacklog = true;
      throw e;
    }
  }

  /**
   * Introduces boards to their lifecycle objects: new boards as they appear, and every board in one pass after this
   * object starts or the settings change (the pass finds nothing once all are introduced). Afterwards each board's
   * own Alarm does the work, and nothing here looks at boards on a timer.
   */
  private async syncLifecycles(): Promise<void> {
    if (!this.lifecycle || this.syncing) return;
    this.syncing = true;
    try {
      const ctx = this.booted!.ctx;
      const fresh = [...this.lifecycleNew];
      this.lifecycleNew.clear();
      let ids = fresh.filter((id) => !isSynced(ctx, id, this.lifecycle!.fingerprint));
      if (this.lifecycleBacklog) {
        const batch = unsyncedBoards(ctx, this.lifecycle.fingerprint, 25);
        this.lifecycleBacklog = batch.length === 25;
        ids = [...new Set([...ids, ...batch])];
      }
      for (const id of ids) await this.nudgeLifecycle(id).catch((e) => console.error(`[lifecycle] board ${id} could not be scheduled: ${e instanceof Error ? e.message : "failed"}`));
    } finally {
      this.syncing = false;
    }
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

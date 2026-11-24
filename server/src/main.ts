import { serve, type ServerType } from "@hono/node-server";
import { getMigrations } from "better-auth/db/migration";
import type { Profile } from "@openmessageboard/protocol";
import { loadConfig, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { migrate, openDatabase } from "./db/index.js";
import { createAuth } from "./auth/auth.js";
import { resolveOpenWorkClient, type OpenWorkClient } from "./auth/openwork.js";
import { createMailer } from "./auth/mailer.js";
import { createResolver, type WorkloadVerifier } from "./auth/resolve.js";
import { createApp } from "./http/app.js";
import { EventSubscriptions } from "./mcp/events.js";
import { runMaintenance } from "./domain/usage.js";
import type { RouteModule } from "./http/util.js";

export interface Features {
  workload?: { verify: WorkloadVerifier; register: RouteModule };
  sync?: { register: RouteModule; start: (ctx: AppContext) => () => void };
}

/** Loads optional feature modules that live in this package. */
export async function loadFeatures(): Promise<Features> {
  const features: Features = {};
  try {
    const w = (await import("./auth/workload.js")) as { verifyWorkloadToken: WorkloadVerifier; registerWorkloadRoutes: RouteModule };
    features.workload = { verify: w.verifyWorkloadToken, register: w.registerWorkloadRoutes };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  try {
    const s = (await import("./sync/index.js")) as { registerSyncRoutes: RouteModule; startSync: (ctx: AppContext) => () => void };
    features.sync = { register: s.registerSyncRoutes, start: s.startSync };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  return features;
}

export interface Running {
  ctx: AppContext;
  app: ReturnType<typeof createApp>["app"];
  stop(): Promise<void>;
  url: string;
}

/** Builds the whole server. `listen: false` returns the app for in-process tests. */
export async function startServer(configIn?: Config, opts: { listen?: boolean; features?: Features } = {}): Promise<Running> {
  const config = configIn ?? loadConfig();
  const db = openDatabase(config.dbPath);
  await migrate(db);
  const ctx = createContext(config, db);
  const mailer = await createMailer(ctx);
  const openworkClient: OpenWorkClient | null = config.authProviders.includes("openwork") ? await resolveOpenWorkClient(ctx) : null;
  if (config.authProviders.includes("openwork") && !openworkClient) console.warn("Sign in with OpenWork is unavailable; check OMB_OPENWORK_ISSUER and network access.");
  const auth = createAuth(ctx, mailer, openworkClient);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const features = opts.features ?? (await loadFeatures());
  const resolver = createResolver(ctx, auth, features.workload?.verify ?? null);
  const events = new EventSubscriptions(ctx);
  const modules: { name: Profile; register: RouteModule }[] = [];
  if (features.workload) modules.push({ name: "workload", register: features.workload.register });
  if (features.sync) modules.push({ name: "sync", register: features.sync.register });
  const { app } = createApp(ctx, { auth, resolver, events, modules, openworkAvailable: openworkClient !== null });

  const stopEvents = events.start();
  const stopSync = features.sync?.start(ctx) ?? (() => {});
  const maintenance = setInterval(() => {
    try {
      runMaintenance(ctx, (boardId, principalId) => {
        ctx.hub.publish({ kind: "access", boardId, principalId, reason: "expired" });
        ctx.connections.closeFor(boardId, principalId, "expired");
      });
      // Accounts disabled by an operator (possibly from another process) lose their open channels.
      const open = [...ctx.connections.principals()];
      for (let i = 0; i < open.length; i += 500) {
        const chunk = open.slice(i, i + 500);
        const disabled = ctx.db
          .prepare(`SELECT p.id FROM principals p LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id IN (${chunk.map(() => "?").join(",")}) AND (p.disabled_at IS NOT NULL OR o.disabled_at IS NOT NULL)`)
          .all(...chunk) as { id: string }[];
        for (const d of disabled) ctx.connections.closePrincipal(d.id, "disabled");
      }
    } catch (e) {
      console.error("maintenance failed", e);
    }
  }, config.testMode ? 1000 : 15_000);
  maintenance.unref();
  // Access changes cut off live channels immediately.
  const unsubAccess = ctx.hub.subscribe((e) => {
    if (e.kind === "access" && e.reason !== "role_changed") ctx.connections.closeFor(e.boardId, e.principalId, e.reason === "expired" ? "expired" : "removed");
    if (e.kind === "board_deleted") ctx.connections.closeFor(e.boardId, null, "board_deleted");
  });

  let server: ServerType | null = null;
  if (opts.listen !== false) {
    server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
    await new Promise<void>((r) => server!.once("listening", () => r()));
  }
  return {
    ctx,
    app,
    url: config.publicUrl,
    async stop() {
      clearInterval(maintenance);
      unsubAccess();
      stopEvents();
      stopSync();
      ctx.connections.closeAll();
      if (server) {
        const s = server as unknown as { closeAllConnections?: () => void; close: (cb: () => void) => void };
        const closed = new Promise<void>((r) => s.close(() => r()));
        s.closeAllConnections?.();
        await closed;
      }
      db.close();
    },
  };
}

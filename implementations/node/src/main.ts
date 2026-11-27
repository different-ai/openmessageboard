import { serve, type ServerType } from "@hono/node-server";
import { bootServer, type AppContext, type Features } from "@openmessageboard/core";
import { loadConfig, type Config } from "./config.js";
import { migrate, openDatabase } from "./db/index.js";
import { createMailer } from "./mailer.js";
import { nodePlatform } from "./platform.js";
import { nodeWeb } from "./web.js";
import { registerWorkloadRoutes, verifyWorkloadToken } from "./features/workload.js";

export type { Features };

/** The optional profiles this runtime offers: workload identity (node:http OIDC fetches) and the core's sync. */
export async function loadFeatures(): Promise<Features> {
  return { workload: { verify: verifyWorkloadToken, register: registerWorkloadRoutes } };
}

export interface Running {
  ctx: AppContext;
  app: Awaited<ReturnType<typeof bootServer>>["app"];
  stop(): Promise<void>;
  url: string;
}

/** Builds and starts the Node server. `listen: false` returns the app for in-process tests. */
export async function startServer(configIn?: Config, opts: { listen?: boolean; features?: Features } = {}): Promise<Running> {
  const config = configIn ?? loadConfig();
  const db = openDatabase(config.dbPath);
  await migrate(db);
  const booted = await bootServer({
    config,
    db,
    platform: nodePlatform(config.dataDir),
    mailer: createMailer,
    features: opts.features ?? (await loadFeatures()),
    web: nodeWeb(config.webDist),
  });
  const stopWorkers = booted.start();
  let server: ServerType | null = null;
  if (opts.listen !== false) {
    server = serve({ fetch: booted.app.fetch, port: config.port, hostname: config.host });
    await new Promise<void>((r) => server!.once("listening", () => r()));
  }
  return {
    ctx: booted.ctx,
    app: booted.app,
    url: config.publicUrl,
    async stop() {
      stopWorkers();
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

import { getMigrations } from "better-auth/db/migration";
import type { Profile } from "@openmessageboard/protocol";
import type { Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import type { DB } from "./db/index.js";
import { createAuth, type Auth } from "./auth/auth.js";
import { resolveOidcClient, type OidcClient } from "./auth/oidc.js";
import { createOutboxMailer, type Mailer } from "./auth/mailer.js";
import { createResolver, type WorkloadVerifier } from "./auth/resolve.js";
import { createApp, type AppOptions } from "./http/app.js";
import type { RouteModule } from "./http/util.js";
import { EventSubscriptions } from "./mcp/events.js";
import { runMaintenance } from "./domain/usage.js";
import { runDueSchedules, startSchedules } from "./domain/schedules.js";
import { WatcherWorker } from "./domain/watchers.js";
import { expireTaskLeases } from "./domain/tasks.js";
import { profileIdsOf } from "./domain/profiles.js";
import { processOutbound, registerSyncRoutes, startSync } from "./sync/index.js";
import type { Platform } from "./platform.js";

/** Optional profiles an implementation adds. Sync ships in the core; workload identity is per runtime. */
export interface Features {
  workload?: { verify: WorkloadVerifier; register: RouteModule };
  sync?: { register: RouteModule; start: (ctx: AppContext) => () => void } | false;
}

export interface BootOptions {
  config: Config;
  /** A migrated database (see `migrate`). */
  db: DB;
  platform: Platform;
  /** A real sender (SMTP, an email API). Without one, codes go to the test outbox and the log. */
  mailer?: (ctx: AppContext) => Mailer | Promise<Mailer>;
  features?: Features;
  web?: AppOptions["web"];
  now?: () => Date;
}

export interface Booted {
  ctx: AppContext;
  app: ReturnType<typeof createApp>["app"];
  auth: Auth;
  events: EventSubscriptions;
  /** Starts background work (deliveries, schedules, watchers, sync, maintenance); returns a stop function. */
  start(): () => void;
  /** Expiry, lease and disabled-account housekeeping (part of `tick`). */
  maintain(): void;
  /** One pass of all background work, for runtimes that wake on alarms: deliveries, schedules, watchers, sync, housekeeping. */
  tick(): Promise<void>;
  /** The earliest time background work is due (a delivery retry, a schedule, a lease or access expiry), or null. */
  nextWakeAt(): Date | null;
}

/** Builds the whole server for any runtime: context, auth, the HTTP and MCP app, and the background workers. */
export async function bootServer(opts: BootOptions): Promise<Booted> {
  const { config } = opts;
  const ctx = createContext(config, opts.db, opts.now, opts.platform);
  const mailer = opts.mailer ? await opts.mailer(ctx) : createOutboxMailer(ctx);
  const oidcClient: OidcClient | null = config.authProviders.includes("oidc") ? await resolveOidcClient(ctx) : null;
  if (config.authProviders.includes("oidc") && !oidcClient) console.warn("OIDC sign-in is unavailable; check OMB_OIDC_ISSUER and network access.");
  const auth = createAuth(ctx, mailer, oidcClient);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const features = opts.features ?? {};
  const sync = features.sync === false ? null : (features.sync ?? { register: registerSyncRoutes, start: startSync });
  const resolver = createResolver(ctx, auth, features.workload?.verify ?? null);
  const events = new EventSubscriptions(ctx);
  const modules: { name: Profile; register: RouteModule }[] = [];
  if (features.workload) modules.push({ name: "workload", register: features.workload.register });
  if (sync) modules.push({ name: "sync", register: sync.register });
  const { app } = createApp(ctx, { auth, resolver, events, modules, oidcAvailable: oidcClient !== null, ...(opts.web ? { web: opts.web } : {}) });

  const maintain = () => {
    try {
      runMaintenance(ctx, (boardId, principalId) => {
        ctx.hub.publish({ kind: "access", boardId, principalId, reason: "expired" });
        ctx.connections.closeFor(boardId, principalId, "expired");
      });
      // Claims whose lease ran out return to the queue.
      expireTaskLeases(ctx);
      // Accounts disabled by an operator (possibly from another process) lose their open channels.
      const open = [...ctx.connections.principals()];
      for (let i = 0; i < open.length; i += 90) {
        const chunk = open.slice(i, i + 90);
        const disabled = ctx.db
          .prepare(`SELECT p.id FROM principals p LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id IN (${chunk.map(() => "?").join(",")}) AND (p.disabled_at IS NOT NULL OR o.disabled_at IS NOT NULL)`)
          .all(...chunk) as { id: string }[];
        for (const d of disabled) ctx.connections.closePrincipal(d.id, "disabled");
      }
    } catch (e) {
      console.error("maintenance failed", e);
    }
  };

  const watchers = new WatcherWorker(ctx);
  let syncing = false;
  const tick = async () => {
    maintain();
    try {
      runDueSchedules(ctx);
    } catch (e) {
      console.error("schedules failed", e);
    }
    await Promise.allSettled([
      events.tick(),
      watchers.tick(),
      (async () => {
        if (!sync || syncing) return;
        syncing = true;
        try {
          await processOutbound(ctx);
        } finally {
          syncing = false;
        }
      })(),
    ]);
  };

  const nextWakeAt = (): Date | null => {
    const due = [
      "SELECT MIN(next_attempt_at) AS t FROM webhook_deliveries WHERE status = 'pending'",
      "SELECT MIN(next_attempt_at) AS t FROM watcher_deliveries WHERE status = 'pending'",
      "SELECT MIN(next_attempt_at) AS t FROM sync_outbound WHERE status = 'pending'",
      "SELECT MIN(next_run_at) AS t FROM schedules WHERE state = 'pending'",
      "SELECT MIN(task_lease_until) AS t FROM threads WHERE task_state = 'claimed'",
      "SELECT MIN(access_ends_at) AS t FROM memberships WHERE access_ends_at IS NOT NULL AND expiry_notified = 0",
      "SELECT MIN(expires_at) AS t FROM event_subscriptions WHERE status = 'active'",
    ];
    let min: string | null = null;
    for (const q of due) {
      try {
        const t = (ctx.db.prepare(q).get() as { t: string | null } | undefined)?.t ?? null;
        if (t && (!min || t < min)) min = t;
      } catch {
        /* a table an implementation leaves out */
      }
    }
    return min ? new Date(min) : null;
  };

  const start = () => {
    const stopEvents = events.start();
    const stopSchedules = startSchedules(ctx);
    const stopWatchers = watchers.start();
    const stopSync = sync?.start(ctx) ?? (() => {});
    const maintenance = setInterval(maintain, config.testMode ? 1000 : 15_000);
    (maintenance as { unref?: () => void }).unref?.();
    // Access changes cut off live channels immediately.
    const unsubAccess = ctx.hub.subscribe((e) => {
      if (e.kind === "access" && e.reason !== "role_changed") {
        const reason = e.reason === "expired" ? "expired" : "removed";
        ctx.connections.closeFor(e.boardId, e.principalId, reason);
        // A person's profiles act with the person's membership, so they lose access with it.
        for (const id of profileIdsOf(ctx, e.principalId)) ctx.connections.closeFor(e.boardId, id, reason);
      }
      if (e.kind === "board_deleted") ctx.connections.closeFor(e.boardId, null, "board_deleted");
    });
    return () => {
      clearInterval(maintenance);
      unsubAccess();
      stopEvents();
      stopSchedules();
      stopWatchers();
      stopSync();
      ctx.connections.closeAll();
    };
  };

  return { ctx, app, auth, events, start, maintain, tick, nextWakeAt };
}

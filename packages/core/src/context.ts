import type { Config } from "./config.js";
import type { DB } from "./db/index.js";
import { Hub, type HubEvent } from "./live/hub.js";
import { ConnectionRegistry } from "./live/connections.js";
import { RateLimiter } from "./live/rateLimit.js";
import { boardLimits, limitsFor } from "./domain/plans.js";
import { NO_PLATFORM, type Platform } from "./platform.js";

export interface AppContext {
  config: Config;
  db: DB;
  hub: Hub;
  connections: ConnectionRegistry;
  rate: RateLimiter;
  now: () => Date;
  /** What the runtime provides: outbound HTTP to user URLs, attachment storage, the auth database. */
  platform: Platform;
}

export function createContext(config: Config, db: DB, now: () => Date = () => new Date(), platform: Platform = NO_PLATFORM): AppContext {
  const ctx: AppContext = {
    config,
    db,
    hub: new Hub(),
    connections: new ConnectionRegistry(
      (boardId) => boardLimits(ctx, boardId).live_connections_per_board,
      (principalId) => limitsFor(ctx, principalId).waits_per_principal,
    ),
    rate: new RateLimiter(() => now().getTime()),
    now,
    platform,
  };
  return ctx;
}

/** Runs `fn` in an IMMEDIATE transaction and publishes collected hub events after commit. */
export function tx<T>(ctx: AppContext, fn: (emit: (e: HubEvent) => void) => T): T {
  const events: HubEvent[] = [];
  const result = ctx.db.transaction(() => fn((e) => events.push(e))).immediate();
  for (const e of events) ctx.hub.publish(e);
  return result;
}

/** Consistent read snapshot. */
export function read<T>(ctx: AppContext, fn: () => T): T {
  return ctx.db.transaction(fn).deferred();
}

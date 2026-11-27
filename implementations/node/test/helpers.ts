import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { createContext, type AppContext } from "@openmessageboard/core/context";
import { nodePlatform } from "../src/platform.ts";
import { migrate, openDatabase } from "../src/db/index.ts";
import { actorFromPrincipal } from "@openmessageboard/core/domain/access";
import { ensureHuman } from "@openmessageboard/core/domain/boards";
import type { Actor } from "@openmessageboard/core/domain/model";

export async function makeCtx(overrides: Partial<Config> = {}, limits: Partial<Config["limits"]> = {}): Promise<AppContext> {
  const dir = mkdtempSync(join(tmpdir(), "omb-test-"));
  const base = loadConfig({ OMB_DATA_DIR: dir, OMB_PUBLIC_URL: "http://omb.test", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email" }, { dbPath: ":memory:", ...overrides });
  base.limits = { ...base.limits, ...limits };
  base.plans = { base: base.limits, openwork: { ...base.plans.openwork, ...limits } };
  const db = openDatabase(":memory:");
  await migrate(db);
  return createContext(base, db, undefined, nodePlatform(dir));
}

export function human(ctx: AppContext, email: string, name?: string): Actor {
  return actorFromPrincipal(ensureHuman(ctx, { email, ...(name ? { displayName: name } : {}) }), "test_token");
}

/** A free TCP port on 127.0.0.1 (the server's public URL must name its real port). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let n = 0;
export const key = () => `k-${++n}-${Math.random().toString(36).slice(2)}`;

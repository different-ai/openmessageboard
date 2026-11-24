import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig as loadCoreConfig, type Config } from "@openmessageboard/core";

export type { Config };

/**
 * Reads configuration from OMB_* environment variables, with the Node runtime's defaults: paths resolve against the
 * working directory, the secret is kept in `$OMB_DATA_DIR/secret.key` when OMB_SECRET is unset, and the browser
 * client is served from the built `web/dist` when it exists.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? resolve(env.OMB_DATA_DIR ?? "./data");
  const dbPath = overrides.dbPath ?? env.OMB_DB_PATH ?? join(dataDir, "openmessageboard.db");
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultWeb = [resolve(here, "../../../web/dist"), resolve(here, "../../web/dist"), resolve(here, "../web")].find((p) => existsSync(join(p, "index.html")));
  const webDist = overrides.webDist !== undefined ? overrides.webDist : env.OMB_WEB_DIST ? resolve(env.OMB_WEB_DIST) : (defaultWeb ?? null);
  const secret = overrides.secret ?? (env.OMB_SECRET || (dbPath === ":memory:" ? randomBytes(32).toString("base64url") : loadOrCreateSecret(dataDir)));
  return loadCoreConfig(env, { ...overrides, dataDir, dbPath, webDist, secret });
}

function loadOrCreateSecret(dataDir: string): string {
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

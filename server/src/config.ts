import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_PROVIDERS, DEFAULT_LIMITS, DEFAULT_RATE_LIMITS, OPENWORK_PLAN_LIMITS, type AuthProvider, type Limits, type Plan, type RateLimits } from "@openmessageboard/protocol";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  secret: string;
  testMode: boolean;
  /** Base plan limits (email-only accounts). Kept as `limits` for server-wide settings such as event retention. */
  limits: Limits;
  plans: Record<Plan, Limits>;
  rateLimits: RateLimits;
  authProviders: AuthProvider[];
  openwork: { issuer: string; clientId: string | null; clientSecret: string | null; signUpUrl: string };
  freeMailDomains: Set<string>;
  smtpUrl: string | null;
  mailFrom: string;
  allowImport: boolean;
  webDist: string | null;
  trustProxy: boolean;
  metricsToken: string | null;
  version: string;
}

const FREE_MAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com",
];

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Reads configuration from OMB_* environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const testMode = envBool(env, "OMB_TEST_MODE", false);
  const port = envInt(env, "OMB_PORT", envInt(env, "PORT", 8787));
  const publicUrl = (env.OMB_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const dataDir = resolve(env.OMB_DATA_DIR ?? "./data");
  const limits = { ...DEFAULT_LIMITS } as Limits;
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    limits[key] = envInt(env, `OMB_LIMIT_${key.toUpperCase()}`, limits[key]);
  }
  const openworkLimits = { ...OPENWORK_PLAN_LIMITS } as Limits;
  for (const key of Object.keys(openworkLimits) as (keyof Limits)[]) {
    openworkLimits[key] = envInt(env, `OMB_OPENWORK_LIMIT_${key.toUpperCase()}`, openworkLimits[key]);
  }
  const providers = (env.OMB_AUTH_PROVIDERS ?? "openwork")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of providers) if (!(AUTH_PROVIDERS as readonly string[]).includes(p)) throw new Error(`OMB_AUTH_PROVIDERS: unknown provider "${p}" (use ${AUTH_PROVIDERS.join(", ")})`);
  if (providers.length === 0) throw new Error("OMB_AUTH_PROVIDERS must name at least one provider");
  const rateLimits = { ...DEFAULT_RATE_LIMITS } as RateLimits;
  for (const key of Object.keys(rateLimits) as (keyof RateLimits)[]) {
    rateLimits[key] = envInt(env, `OMB_RATE_${key.toUpperCase()}`, rateLimits[key]);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultWeb = [resolve(here, "../../web/dist"), resolve(here, "../web")].find((p) => existsSync(join(p, "index.html")));
  const config: Config = {
    port,
    host: env.OMB_HOST ?? "0.0.0.0",
    publicUrl,
    dataDir,
    dbPath: env.OMB_DB_PATH ?? join(dataDir, "openmessageboard.db"),
    secret: env.OMB_SECRET ?? "",
    testMode,
    limits,
    plans: { base: limits, openwork: openworkLimits },
    rateLimits,
    authProviders: providers as AuthProvider[],
    openwork: {
      issuer: (env.OMB_OPENWORK_ISSUER ?? "https://app.openworklabs.com/api/auth").replace(/\/+$/, ""),
      clientId: env.OMB_OPENWORK_CLIENT_ID || null,
      clientSecret: env.OMB_OPENWORK_CLIENT_SECRET || null,
      signUpUrl: env.OMB_OPENWORK_SIGN_UP_URL ?? "https://app.openworklabs.com",
    },
    freeMailDomains: new Set((env.OMB_FREE_MAIL_DOMAINS?.split(",") ?? FREE_MAIL).map((d) => d.trim().toLowerCase()).filter(Boolean)),
    smtpUrl: env.OMB_SMTP_URL ?? null,
    mailFrom: env.OMB_MAIL_FROM ?? "OpenMessageBoard <no-reply@localhost>",
    allowImport: envBool(env, "OMB_ALLOW_IMPORT", true),
    webDist: env.OMB_WEB_DIST ? resolve(env.OMB_WEB_DIST) : (defaultWeb ?? null),
    trustProxy: envBool(env, "OMB_TRUST_PROXY", false),
    metricsToken: env.OMB_METRICS_TOKEN || null,
    version: "0.1.0",
    ...overrides,
  };
  if (!config.secret) config.secret = loadOrCreateSecret(config);
  if (config.secret.length < 32) throw new Error("OMB_SECRET must be at least 32 characters");
  return config;
}

function loadOrCreateSecret(config: Config): string {
  if (config.dbPath === ":memory:") return randomBytes(32).toString("base64url");
  const file = join(config.dataDir, "secret.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(config.dataDir, { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

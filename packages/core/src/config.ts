import { randomBytes } from "node:crypto";
import { AUTH_PROVIDERS, DEFAULT_LIMITS, DEFAULT_RATE_LIMITS, OPENWORK_PLAN_LIMITS, type AuthProvider, type Limits, type Plan, type RateLimits, trimTrailingSlashes } from "@openmessageboard/protocol";

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
  /** How often the scheduled-post runner looks for due schedules. */
  scheduleTickMs: number;
  version: string;
}

/** Test mode only: shorter defaults so the conformance suite can watch schedules repeat. */
const TEST_MODE_MIN_REPEAT_SECONDS = 2;

const FREE_MAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com",
];

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function envBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type Env = Record<string, string | undefined>;

/**
 * Reads configuration from OMB_* variables. Runtime-neutral: the Node implementation resolves paths and keeps the
 * secret in a file before calling this; the Cloudflare implementation passes its bindings' variables.
 */
export function loadConfig(env: Env, overrides: Partial<Config> = {}): Config {
  const testMode = envBool(env, "OMB_TEST_MODE", false);
  const port = envInt(env, "OMB_PORT", envInt(env, "PORT", 8787));
  const publicUrl = trimTrailingSlashes(env.OMB_PUBLIC_URL ?? `http://localhost:${port}`);
  const dataDir = env.OMB_DATA_DIR ?? "./data";
  const limits = { ...DEFAULT_LIMITS } as Limits;
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    limits[key] = envInt(env, `OMB_LIMIT_${key.toUpperCase()}`, limits[key]);
  }
  const openworkLimits = { ...OPENWORK_PLAN_LIMITS } as Limits;
  for (const key of Object.keys(openworkLimits) as (keyof Limits)[]) {
    openworkLimits[key] = envInt(env, `OMB_OPENWORK_LIMIT_${key.toUpperCase()}`, openworkLimits[key]);
  }
  if (testMode) {
    if (!env.OMB_LIMIT_SCHEDULE_MIN_REPEAT_SECONDS) limits.schedule_min_repeat_seconds = TEST_MODE_MIN_REPEAT_SECONDS;
    if (!env.OMB_OPENWORK_LIMIT_SCHEDULE_MIN_REPEAT_SECONDS) openworkLimits.schedule_min_repeat_seconds = TEST_MODE_MIN_REPEAT_SECONDS;
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
  const config: Config = {
    port,
    host: env.OMB_HOST ?? "0.0.0.0",
    publicUrl,
    dataDir,
    dbPath: env.OMB_DB_PATH ?? `${trimTrailingSlashes(dataDir)}/openmessageboard.db`,
    secret: env.OMB_SECRET ?? "",
    testMode,
    limits,
    plans: { base: limits, openwork: openworkLimits },
    rateLimits,
    authProviders: providers as AuthProvider[],
    openwork: {
      issuer: trimTrailingSlashes(env.OMB_OPENWORK_ISSUER ?? "https://app.openworklabs.com/api/auth"),
      clientId: env.OMB_OPENWORK_CLIENT_ID || null,
      clientSecret: env.OMB_OPENWORK_CLIENT_SECRET || null,
      signUpUrl: env.OMB_OPENWORK_SIGN_UP_URL ?? "https://app.openworklabs.com",
    },
    freeMailDomains: new Set((env.OMB_FREE_MAIL_DOMAINS?.split(",") ?? FREE_MAIL).map((d) => d.trim().toLowerCase()).filter(Boolean)),
    smtpUrl: env.OMB_SMTP_URL ?? null,
    mailFrom: env.OMB_MAIL_FROM ?? "OpenMessageBoard <no-reply@localhost>",
    allowImport: envBool(env, "OMB_ALLOW_IMPORT", true),
    webDist: env.OMB_WEB_DIST ?? null,
    trustProxy: envBool(env, "OMB_TRUST_PROXY", false),
    metricsToken: env.OMB_METRICS_TOKEN || null,
    scheduleTickMs: Math.max(100, envInt(env, "OMB_SCHEDULE_TICK_MS", testMode ? 500 : 5000)),
    version: "0.1.0-alpha.2",
    ...overrides,
  };
  if (!config.secret) {
    if (config.dbPath !== ":memory:") throw new Error("OMB_SECRET is required (32 or more characters)");
    config.secret = randomBytes(32).toString("base64url");
  }
  if (config.secret.length < 32) throw new Error("OMB_SECRET must be at least 32 characters");
  return config;
}

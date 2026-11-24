import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROFILE_NAME_PATTERN } from "@openmessageboard/protocol";
import { OmbError, githubActionsOidc, normalizeServer, vercelOidc, type TokenProvider } from "@openmessageboard/sdk";

export interface Account {
  token?: string;
}

/**
 * `$XDG_CONFIG_HOME/openmessageboard/config.json`, mode 0600. Saved credentials are "accounts"
 * (`--account <name>`); files written before accounts were named `profiles` are still read.
 */
export interface Config {
  server?: string;
  accounts: Record<string, Account>;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "openmessageboard", "config.json");
}

export function readConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { accounts: {} };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OmbError("invalid_argument", `${path} is not valid JSON`);
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as { server?: unknown; accounts?: unknown; profiles?: unknown };
  const source = obj.accounts && typeof obj.accounts === "object" ? obj.accounts : obj.profiles;
  const accounts: Record<string, Account> = {};
  if (source && typeof source === "object") {
    for (const [name, p] of Object.entries(source as Record<string, unknown>)) {
      const token = (p as { token?: unknown } | null)?.token;
      accounts[name] = typeof token === "string" ? { token } : {};
    }
  }
  return { server: typeof obj.server === "string" ? obj.server : undefined, accounts };
}

/** Writes atomically with mode 0600 (directory 0700); tightens an existing file's mode too. */
export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ server: config.server, accounts: config.accounts }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function validateAccount(name: string): string {
  if (!ACCOUNT_NAME.test(name)) throw new OmbError("invalid_argument", `Account names use letters, digits, . _ - (up to 40): ${name}`);
  return name;
}

/** A profile to write as (`--as`, `OMB_PROFILE`): starts with a letter, up to 32 letters, digits and hyphens. */
export function validateProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) throw new OmbError("invalid_argument", `Profile names start with a letter and use up to 32 letters, digits and hyphens: ${name}`);
  return name;
}

export interface ConnectionFlags {
  server?: string;
  account?: string;
  /** The profile to write as. */
  as?: string;
  oidc?: string;
}

export interface ResolvedConnection {
  server: string;
  /** The saved account whose token is used (when the credential came from the config). */
  account: string;
  /** The profile requests write as (`OMB-Profile`), or null. */
  profile: string | null;
  token?: string;
  tokenProvider?: TokenProvider;
  /** Where the credential came from, for messages. */
  source: "oidc:github" | "oidc:vercel" | "account" | "env";
}

/**
 * Picks the server, credential and profile.
 * Server: --server, then OMB_SERVER, then the config.
 * Credential: --oidc, then the --account, then OMB_TOKEN, then the default account.
 * Profile: --as, then OMB_PROFILE.
 */
export function resolveConnection(flags: ConnectionFlags, env: NodeJS.ProcessEnv, config: Config): ResolvedConnection {
  const rawServer = flags.server ?? env.OMB_SERVER?.trim() ?? config.server;
  if (!rawServer) throw new OmbError("invalid_argument", "No server configured. Run `omb login --server <url>`, pass --server, or set OMB_SERVER.");
  const server = normalizeServer(rawServer);
  const account = validateAccount(flags.account ?? "default");
  const rawProfile = flags.as ?? (env.OMB_PROFILE?.trim() || undefined);
  const profile = rawProfile === undefined ? null : validateProfileName(rawProfile);

  if (flags.oidc !== undefined) {
    if (flags.oidc === "github") return { server, account, profile, tokenProvider: githubActionsOidc(), source: "oidc:github" };
    if (flags.oidc === "vercel") return { server, account, profile, tokenProvider: vercelOidc(), source: "oidc:vercel" };
    throw new OmbError("invalid_argument", `--oidc must be github or vercel, not ${flags.oidc}`);
  }
  if (flags.account !== undefined) {
    const token = config.accounts[account]?.token;
    if (!token) throw new OmbError("unauthenticated", `No token saved for account "${account}". Run \`omb login --account ${account}\`.`);
    return { server, account, profile, token, source: "account" };
  }
  const envToken = env.OMB_TOKEN?.trim();
  if (envToken) return { server, account, profile, token: envToken, source: "env" };
  const token = config.accounts.default?.token;
  if (!token) throw new OmbError("unauthenticated", "Not logged in. Run `omb login --server <url>`, set OMB_TOKEN, or use --oidc github|vercel.");
  return { server, account, profile, token, source: "account" };
}

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OmbError, githubActionsOidc, normalizeServer, vercelOidc, type TokenProvider } from "@openmessageboard/sdk";

export interface Profile {
  token?: string;
}

/** `$XDG_CONFIG_HOME/openmessageboard/config.json`, mode 0600. */
export interface Config {
  server?: string;
  profiles: Record<string, Profile>;
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OmbError("invalid_argument", `${path} is not valid JSON`);
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as { server?: unknown; profiles?: unknown };
  const profiles: Record<string, Profile> = {};
  if (obj.profiles && typeof obj.profiles === "object") {
    for (const [name, p] of Object.entries(obj.profiles as Record<string, unknown>)) {
      const token = (p as { token?: unknown } | null)?.token;
      profiles[name] = typeof token === "string" ? { token } : {};
    }
  }
  return { server: typeof obj.server === "string" ? obj.server : undefined, profiles };
}

/** Writes atomically with mode 0600 (directory 0700); tightens an existing file's mode too. */
export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function validateProfile(name: string): string {
  if (!PROFILE_NAME.test(name)) throw new OmbError("invalid_argument", `Profile names use letters, digits, . _ - (up to 40): ${name}`);
  return name;
}

export interface ConnectionFlags {
  server?: string;
  as?: string;
  oidc?: string;
}

export interface ResolvedConnection {
  server: string;
  profile: string;
  token?: string;
  tokenProvider?: TokenProvider;
  /** Where the credential came from, for messages. */
  source: "oidc:github" | "oidc:vercel" | "profile" | "env";
}

/**
 * Picks the server and credential.
 * Server: --server, then OMB_SERVER, then the config.
 * Credential: --oidc, then the --as profile, then OMB_TOKEN, then the default profile.
 */
export function resolveConnection(flags: ConnectionFlags, env: NodeJS.ProcessEnv, config: Config): ResolvedConnection {
  const rawServer = flags.server ?? env.OMB_SERVER?.trim() ?? config.server;
  if (!rawServer) throw new OmbError("invalid_argument", "No server configured. Run `omb login --server <url>`, pass --server, or set OMB_SERVER.");
  const server = normalizeServer(rawServer);
  const profile = validateProfile(flags.as ?? "default");

  if (flags.oidc !== undefined) {
    if (flags.oidc === "github") return { server, profile, tokenProvider: githubActionsOidc(), source: "oidc:github" };
    if (flags.oidc === "vercel") return { server, profile, tokenProvider: vercelOidc(), source: "oidc:vercel" };
    throw new OmbError("invalid_argument", `--oidc must be github or vercel, not ${flags.oidc}`);
  }
  if (flags.as !== undefined) {
    const token = config.profiles[profile]?.token;
    if (!token) throw new OmbError("unauthenticated", `No token saved for profile "${profile}". Run \`omb login --as ${profile}\`.`);
    return { server, profile, token, source: "profile" };
  }
  const envToken = env.OMB_TOKEN?.trim();
  if (envToken) return { server, profile, token: envToken, source: "env" };
  const token = config.profiles.default?.token;
  if (!token) throw new OmbError("unauthenticated", "Not logged in. Run `omb login --server <url>`, set OMB_TOKEN, or use --oidc github|vercel.");
  return { server, profile, token, source: "profile" };
}

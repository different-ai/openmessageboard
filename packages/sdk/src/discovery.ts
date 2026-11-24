import { ServerInfo } from "@openmessageboard/protocol";
import { OmbError, toOmbError } from "./errors.js";

/**
 * Normalizes what a person types as the server: trims trailing slashes and accepts the MCP endpoint
 * (`https://host/mcp`) as well as the base URL. Board, thread and inbox URIs are built from the result.
 */
export function normalizeServer(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OmbError("invalid_argument", `Not a server URL: ${raw || "(empty)"}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OmbError("invalid_argument", `Server URL must use http or https: ${raw}`);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/mcp")) path = path.slice(0, -4);
  return `${url.origin}${path}`;
}

/**
 * Reads `GET <server>/.well-known/openmessageboard` (no authentication): spec version, profiles,
 * MCP endpoint, issuer and limits.
 */
export async function discoverServer(server: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ServerInfo> {
  const base = normalizeServer(server);
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/.well-known/openmessageboard`, { headers: { Accept: "application/json" }, signal: options.signal });
  } catch (err) {
    throw toOmbError(err);
  }
  if (!res.ok) {
    if (res.status === 404) throw new OmbError("not_found", `${base} does not look like an OpenMessageBoard server (no discovery document)`, { status: 404 });
    throw new OmbError(res.status >= 500 ? "network" : "protocol", `Discovery failed (HTTP ${res.status})`, { status: res.status });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new OmbError("invalid_response", "Discovery document is not JSON", undefined, { cause: err });
  }
  const parsed = ServerInfo.safeParse(body);
  if (!parsed.success) throw new OmbError("invalid_response", "Discovery document does not match the protocol", { issues: parsed.error.issues });
  return parsed.data;
}

import type { AppContext } from "../context.js";

export const OPENWORK_PROVIDER_ID = "openwork";
export const OPENWORK_SCOPES = ["openid", "profile", "email"];

export function openworkRedirectUri(ctx: AppContext): string {
  return `${ctx.config.publicUrl}/api/auth/callback/${OPENWORK_PROVIDER_ID}`;
}

export function clientMetadataUrl(ctx: AppContext): string {
  return `${ctx.config.publicUrl}/oauth/openwork-client.json`;
}

/**
 * Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document). On an https deployment the URL of this
 * document is the client ID, so OpenWork Cloud needs no prior registration for this server.
 */
export function clientMetadataDocument(ctx: AppContext) {
  return {
    client_id: clientMetadataUrl(ctx),
    client_name: "OpenMessageBoard",
    client_uri: ctx.config.publicUrl,
    redirect_uris: [openworkRedirectUri(ctx)],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: OPENWORK_SCOPES.join(" "),
    application_type: "web",
  };
}

export interface OpenWorkClient {
  clientId: string;
  clientSecret: string | null;
  mode: "configured" | "metadata_document" | "registered";
}

/**
 * Chooses how this server identifies itself to OpenWork Cloud:
 * 1. OMB_OPENWORK_CLIENT_ID (and optional secret) when the operator registered a client;
 * 2. its Client ID Metadata Document URL on https deployments (no registration needed);
 * 3. otherwise (local development over http) dynamic client registration, cached in the database.
 * Returns null when OpenWork sign-in can't be set up; the server then reports it as unavailable.
 */
export async function resolveOpenWorkClient(ctx: AppContext, fetchImpl: typeof fetch = fetch): Promise<OpenWorkClient | null> {
  const { openwork, publicUrl } = ctx.config;
  if (openwork.clientId) return { clientId: openwork.clientId, clientSecret: openwork.clientSecret, mode: "configured" };
  if (publicUrl.startsWith("https://")) return { clientId: clientMetadataUrl(ctx), clientSecret: null, mode: "metadata_document" };
  const cacheKey = `openwork_client:${openwork.issuer}:${openworkRedirectUri(ctx)}`;
  const cached = ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(cacheKey) as { value: string } | undefined;
  if (cached) {
    const v = JSON.parse(cached.value) as { client_id: string; client_secret?: string };
    return { clientId: v.client_id, clientSecret: v.client_secret ?? null, mode: "registered" };
  }
  try {
    const discovery = (await (await fetchImpl(`${openwork.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).json()) as {
      registration_endpoint?: string;
    };
    if (!discovery.registration_endpoint) return null;
    const res = await fetchImpl(discovery.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OpenMessageBoard (development)",
        client_uri: publicUrl,
        redirect_uris: [openworkRedirectUri(ctx)],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: OPENWORK_SCOPES.join(" "),
        application_type: "web",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`OpenWork sign-in unavailable: client registration returned ${res.status}`);
      return null;
    }
    const reg = (await res.json()) as { client_id: string; client_secret?: string };
    ctx.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(cacheKey, JSON.stringify(reg));
    return { clientId: reg.client_id, clientSecret: reg.client_secret ?? null, mode: "registered" };
  } catch (e) {
    console.warn(`OpenWork sign-in unavailable: ${(e as Error).message}`);
    return null;
  }
}

import type { AppContext } from "../context.js";

/** Sign-in through an OpenID Connect provider the host configures (OMB_OIDC_ISSUER). No provider is built in. */
export const OIDC_PROVIDER_ID = "oidc";
export const OIDC_SCOPES = ["openid", "profile", "email"];

export function oidcRedirectUri(ctx: AppContext): string {
  return `${ctx.config.publicUrl}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}

export function clientMetadataUrl(ctx: AppContext): string {
  return `${ctx.config.publicUrl}/oauth/oidc-client.json`;
}

/**
 * Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document). On an https deployment the URL of this
 * document is the client ID, so a provider that supports these documents needs no prior registration for this server.
 */
export function clientMetadataDocument(ctx: AppContext) {
  return {
    client_id: clientMetadataUrl(ctx),
    client_name: "OpenMessageBoard",
    client_uri: ctx.config.publicUrl,
    redirect_uris: [oidcRedirectUri(ctx)],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: OIDC_SCOPES.join(" "),
    application_type: "web",
  };
}

export interface OidcClient {
  clientId: string;
  clientSecret: string | null;
  mode: "configured" | "metadata_document" | "registered";
}

/**
 * Chooses how this server identifies itself to the configured OpenID Connect provider:
 * 1. OMB_OIDC_CLIENT_ID (and optional secret) when the operator registered a client;
 * 2. its Client ID Metadata Document URL on https deployments (no registration needed);
 * 3. otherwise (local development over http) dynamic client registration, cached in the database.
 * Returns null when the provider can't be set up; the server then reports it as unavailable.
 */
export async function resolveOidcClient(ctx: AppContext, fetchImpl: typeof fetch = fetch): Promise<OidcClient | null> {
  const { oidc, publicUrl } = ctx.config;
  if (!oidc.issuer) return null;
  if (oidc.clientId) return { clientId: oidc.clientId, clientSecret: oidc.clientSecret, mode: "configured" };
  if (publicUrl.startsWith("https://")) return { clientId: clientMetadataUrl(ctx), clientSecret: null, mode: "metadata_document" };
  const cacheKey = `oidc_client:${oidc.issuer}:${oidcRedirectUri(ctx)}`;
  const cached = ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(cacheKey) as { value: string } | undefined;
  if (cached) {
    const v = JSON.parse(cached.value) as { client_id: string; client_secret?: string };
    return { clientId: v.client_id, clientSecret: v.client_secret ?? null, mode: "registered" };
  }
  try {
    const discovery = (await (await fetchImpl(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).json()) as {
      registration_endpoint?: string;
    };
    if (!discovery.registration_endpoint) return null;
    const res = await fetchImpl(discovery.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OpenMessageBoard (development)",
        client_uri: publicUrl,
        redirect_uris: [oidcRedirectUri(ctx)],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: OIDC_SCOPES.join(" "),
        application_type: "web",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`OIDC sign-in unavailable: client registration returned ${res.status}`);
      return null;
    }
    const reg = (await res.json()) as { client_id: string; client_secret?: string };
    ctx.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(cacheKey, JSON.stringify(reg));
    return { clientId: reg.client_id, clientSecret: reg.client_secret ?? null, mode: "registered" };
  } catch (e) {
    console.warn(`OIDC sign-in unavailable: ${(e as Error).message}`);
    return null;
  }
}

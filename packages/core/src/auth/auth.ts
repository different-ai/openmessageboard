import { betterAuth } from "better-auth";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type { AppContext } from "../context.js";
import { sha256 } from "../ids.js";
import { SIGN_IN_TTL_SECONDS } from "./signin-link.js";
import { OIDC_PROVIDER_ID, OIDC_SCOPES, type OidcClient } from "./oidc.js";

export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", "boards"] as const;
export const OPAQUE_ACCESS_PREFIX = "omb_oat_";
export const REFRESH_PREFIX = "omb_ort_";

const isLoopback = (u: URL) => u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);

/** Per-session principal choice made on the consent page (self or one of the person's agents). */
export function consentChoiceFor(ctx: AppContext, sessionId: string): string | undefined {
  const row = ctx.db.prepare("SELECT principal_id FROM oauth_consent_choice WHERE session_id = ? AND expires_at > ?").get(sessionId, ctx.now().toISOString()) as
    | { principal_id: string }
    | undefined;
  return row?.principal_id;
}

export function createAuth(ctx: AppContext, oidcClient: OidcClient | null = null) {
  const { publicUrl, secret, testMode, authProviders } = ctx.config;
  const emailEnabled = authProviders.includes("email");
  const oidcEnabled = authProviders.includes("oidc") && oidcClient !== null;
  return betterAuth({
    appName: "OpenMessageBoard",
    baseURL: publicUrl,
    basePath: "/api/auth",
    secret,
    database: (ctx.platform.authDatabase ?? ctx.db) as never,
    trustedOrigins: [publicUrl],
    emailAndPassword: { enabled: false },
    disabledPaths: ["/email-otp/send-verification-otp"],
    // Someone who first signed in by email and later signs in through the OpenID Connect provider keeps one account.
    account: { accountLinking: { enabled: true, trustedProviders: [OIDC_PROVIDER_ID] } },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      cookiePrefix: "omb",
      useSecureCookies: publicUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ctx.config.trustProxy ? ["x-forwarded-for"] : [] },
    },
    rateLimit: { enabled: !testMode, window: 60, max: 100 },
    plugins: [
      ...(oidcEnabled
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  name: ctx.config.oidc.name,
                  discoveryUrl: `${ctx.config.oidc.issuer}/.well-known/openid-configuration`,
                  clientId: oidcClient!.clientId,
                  ...(oidcClient!.clientSecret ? { clientSecret: oidcClient!.clientSecret } : { tokenEndpointAuth: { method: "none" as const } }),
                  scopes: OIDC_SCOPES,
                  pkce: true,
                  // Stable account identity: the verified ID token's subject, else the userinfo subject.
                  accountSubject: ({ tokens, profile }) => {
                    const p = profile as { sub?: unknown; id?: unknown };
                    if (tokens.idToken) {
                      try {
                        const claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
                        if (typeof claims.sub === "string" && claims.sub) return claims.sub;
                      } catch {
                        /* fall through */
                      }
                    }
                    return String(p.sub ?? p.id ?? "");
                  },
                  redirectURI: `${publicUrl}/api/auth/callback/${OIDC_PROVIDER_ID}`,
                },
              ],
            }),
          ]
        : []),
      // Email sign-in is started by POST /api/sign-in/start (auth/signin-link.ts), which emails a link and this
      // plugin's code together. The plugin's own send route is disabled (below) so every email goes through there.
      ...(emailEnabled
        ? [
            emailOTP({
              otpLength: 6,
              expiresIn: SIGN_IN_TTL_SECONDS,
              allowedAttempts: 5,
              storeOTP: "hashed",
              async sendVerificationOTP() {
                throw new Error("Sign-in email is sent by POST /api/sign-in/start");
              },
            }),
          ]
        : []),
      oauthProvider({
        loginPage: `${publicUrl}/signin`,
        consentPage: `${publicUrl}/oauth/consent`,
        scopes: [...OAUTH_SCOPES],
        resources: [`${publicUrl}/mcp`],
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        allowPublicClientPrelogin: true,
        clientRegistrationDefaultScopes: ["boards", "offline_access"],
        clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
        clientRegistrationDefaultApplicationType: "infer",
        disableJwtPlugin: true,
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        refreshTokenReuseInterval: 30,
        storeTokens: { hash: (token: string) => sha256(token) },
        prefix: { opaqueAccessToken: OPAQUE_ACCESS_PREFIX, refreshToken: REFRESH_PREFIX },
        // RFC 8252: native clients may use any port on a loopback redirect URI.
        validateRedirectUri: (redirectUri, registered, defaultResult) => {
          if (defaultResult) return true;
          try {
            const r = new URL(redirectUri);
            if (!isLoopback(r)) return false;
            return registered.some((reg) => {
              const u = new URL(reg);
              return isLoopback(u) && u.pathname === r.pathname && u.hostname === r.hostname;
            });
          } catch {
            return false;
          }
        },
        allowInsecureRedirectUri: (url) => isLoopback(url),
        postLogin: {
          page: `${publicUrl}/oauth/consent`,
          shouldRedirect: () => false,
          consentReferenceId: ({ session }) => consentChoiceFor(ctx, String(session.id)),
        },
      }),
      cimd({ fetchClientMetadataResource }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

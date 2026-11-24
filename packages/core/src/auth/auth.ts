import { betterAuth } from "better-auth";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type { AppContext } from "../context.js";
import { sha256 } from "../ids.js";
import type { Mailer } from "./mailer.js";
import { OPENWORK_PROVIDER_ID, OPENWORK_SCOPES, type OpenWorkClient } from "./openwork.js";

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

export function createAuth(ctx: AppContext, mailer: Mailer, openworkClient: OpenWorkClient | null = null) {
  const { publicUrl, secret, testMode, authProviders } = ctx.config;
  const emailEnabled = authProviders.includes("email");
  const openworkEnabled = authProviders.includes("openwork") && openworkClient !== null;
  return betterAuth({
    appName: "OpenMessageBoard",
    baseURL: publicUrl,
    basePath: "/api/auth",
    secret,
    database: (ctx.platform.authDatabase ?? ctx.db) as never,
    trustedOrigins: [publicUrl],
    emailAndPassword: { enabled: false },
    // Someone who first signed in by email and later signs in with OpenWork Cloud keeps one account.
    account: { accountLinking: { enabled: true, trustedProviders: [OPENWORK_PROVIDER_ID] } },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      cookiePrefix: "omb",
      useSecureCookies: publicUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ctx.config.trustProxy ? ["x-forwarded-for"] : [] },
    },
    rateLimit: { enabled: !testMode, window: 60, max: 100 },
    plugins: [
      ...(openworkEnabled
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OPENWORK_PROVIDER_ID,
                  name: "OpenWork",
                  discoveryUrl: `${ctx.config.openwork.issuer}/.well-known/openid-configuration`,
                  clientId: openworkClient!.clientId,
                  ...(openworkClient!.clientSecret ? { clientSecret: openworkClient!.clientSecret } : { tokenEndpointAuth: { method: "none" as const } }),
                  scopes: OPENWORK_SCOPES,
                  pkce: true,
                  // Stable OpenWork account identity: the verified ID token's subject, else the userinfo subject.
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
                  redirectURI: `${publicUrl}/api/auth/callback/${OPENWORK_PROVIDER_ID}`,
                },
              ],
            }),
          ]
        : []),
      ...(emailEnabled ? [emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp }) {
          ctx.rate.hit(`otp:${email.toLowerCase()}`, ctx.config.rateLimits.sign_in_codes_per_hour, 3_600_000);
          await mailer.send({
            to: email,
            subject: `Your OpenMessageBoard sign-in code: ${otp}`,
            text: `Your sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
            code: otp,
          });
        },
      })] : []),
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

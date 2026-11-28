import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { forbidden } from "../errors.js";
import type { Auth } from "../auth/auth.js";
import type { Mailer } from "../auth/mailer.js";
import {
  SIGN_IN_COOKIE,
  SIGN_IN_COOKIE_PATH,
  SIGN_IN_TTL_SECONDS,
  cancelSignInLink,
  claimSignIn,
  confirmSignInLink,
  inspectSignInLink,
  startSignIn,
} from "../auth/signin-link.js";
import { parseBody, type AppCtx, type AppHono } from "./util.js";

const StartBody = z.object({ email: z.string().min(3).max(254) });
const TokenBody = z.object({ token: z.string().min(40).max(100) });

/**
 * Email sign-in for the browser client (see auth/signin-link.ts). Every route is a POST from our own origin, so
 * opening the emailed link (a GET, by a person, a mail scanner or a link previewer) changes nothing.
 */
export function registerSignInRoutes(app: AppHono, ctx: AppContext, auth: Auth, mailer: Mailer): void {
  if (!ctx.config.authProviders.includes("email")) return;
  const origin = new URL(ctx.config.publicUrl).origin;
  const secure = ctx.config.publicUrl.startsWith("https://");

  /** These routes act on cookies before any session exists, so they check the origin themselves. */
  function sameOrigin(c: AppCtx): void {
    const reqOrigin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if ((reqOrigin && reqOrigin !== origin) || (!reqOrigin && site && site !== "same-origin")) throw forbidden("Cross-site request refused");
  }

  /** The client address for the per-IP limit: the proxy's header when one is trusted, else the connection's. */
  function clientIp(c: AppCtx): string | null {
    if (ctx.config.trustProxy) return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
    if (ctx.platform.name === "cloudflare") return c.req.header("cf-connecting-ip") ?? null;
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? null;
  }

  const browserCookie = (value: string, maxAge: number) =>
    `${SIGN_IN_COOKIE}=${value}; Path=${SIGN_IN_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  app.post("/api/sign-in/start", async (c) => {
    sameOrigin(c);
    const body = await parseBody(c, StartBody);
    const { cookie } = await startSignIn(ctx, auth, mailer, body.email, clientIp(c));
    c.header("Set-Cookie", browserCookie(cookie, SIGN_IN_TTL_SECONDS));
    return c.json({ ok: true, expires_in: SIGN_IN_TTL_SECONDS });
  });

  app.post("/api/sign-in/claim", async (c) => {
    sameOrigin(c);
    const { status, setCookies } = await claimSignIn(ctx, auth, getCookie(c, SIGN_IN_COOKIE), c.req.raw.headers);
    for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true });
    // The cookie stays after a claim (it expires with the sign-in): another tab of this browser may still be waiting.
    if (status === "expired") c.header("Set-Cookie", browserCookie("", 0), { append: true });
    c.header("Cache-Control", "no-store");
    return c.json({ status });
  });

  app.post("/api/sign-in/link/inspect", async (c) => {
    sameOrigin(c);
    const { token } = await parseBody(c, TokenBody);
    c.header("Cache-Control", "no-store");
    return c.json(inspectSignInLink(ctx, token, getCookie(c, SIGN_IN_COOKIE)));
  });

  app.post("/api/sign-in/link/confirm", async (c) => {
    sameOrigin(c);
    const { token } = await parseBody(c, TokenBody);
    return c.json(confirmSignInLink(ctx, token, getCookie(c, SIGN_IN_COOKIE)));
  });

  app.post("/api/sign-in/link/cancel", async (c) => {
    sameOrigin(c);
    const { token } = await parseBody(c, TokenBody);
    cancelSignInLink(ctx, token);
    return c.json({ ok: true });
  });
}

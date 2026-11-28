import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import { newId, randomToken, sha256 } from "../ids.js";
import type { Auth } from "./auth.js";
import type { Mailer } from "./mailer.js";

/**
 * Sign-in by emailed link, with the one-time code in the same email as a fallback.
 *
 * Two secrets take part, and a session needs both:
 * - the link's token (256 bits), which only the mailbox receives;
 * - the browser secret (256 bits), a cookie only the browser that started the sign-in holds.
 *
 * Confirming the link (a POST from its page, never a GET) marks the sign-in confirmed, once. The browser that
 * started it then claims its session, once. So the link works when the email is read on another device: the waiting
 * page, and an OAuth authorization behind it, continue where the sign-in began. The device that opened the link gets
 * nothing, and a browser without the cookie cannot claim. Both secrets are stored only as SHA-256 hashes.
 */

export const SIGN_IN_TTL_SECONDS = 600;
/** Sign-in emails per hour from one IP, as a multiple of `sign_in_codes_per_hour` (which is per address). */
export const SIGN_IN_IP_FACTOR = 4;
/** The cookie that ties a sign-in to the browser that started it. Sent only to the sign-in routes. */
export const SIGN_IN_COOKIE = "omb_signin";
export const SIGN_IN_COOKIE_PATH = "/api/sign-in";

const EXPIRED = "This sign-in link has expired or was already used. Ask for a new one on the sign-in page.";
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

interface Row {
  id: string;
  email: string;
  browser_hash: string;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  claimed_at: string | null;
}

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw invalid("Enter a valid email address");
  return email;
}

/** `id.secret` from the cookie, when it names a sign-in this browser started. */
function rowForBrowser(ctx: AppContext, cookie: string | undefined): Row | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return null;
  const row = ctx.db.prepare("SELECT * FROM sign_in_links WHERE id = ?").get(cookie.slice(0, dot)) as Row | undefined;
  return row && row.browser_hash === sha256(cookie.slice(dot + 1)) ? row : null;
}

function rowForToken(ctx: AppContext, token: string): Row {
  const row = ctx.db.prepare("SELECT * FROM sign_in_links WHERE token_hash = ?").get(sha256(token)) as Row | undefined;
  if (!row || row.confirmed_at || row.expires_at <= ctx.now().toISOString()) throw invalid(EXPIRED);
  return row;
}

/**
 * Starts a sign-in: emails the link and the code, and returns the cookie value for the browser that asked.
 * The answer, the limits and the email are the same whether or not the address has an account.
 */
export async function startSignIn(ctx: AppContext, auth: Auth, mailer: Mailer, rawEmail: string, ip: string | null): Promise<{ cookie: string }> {
  const email = normalizeEmail(rawEmail);
  const limit = ctx.config.rateLimits.sign_in_codes_per_hour;
  // People share addresses (an office, a household), so one IP gets a few addresses' worth.
  if (ip) ctx.rate.hit(`sign-in-ip:${ip}`, limit * SIGN_IN_IP_FACTOR, 3_600_000);
  ctx.rate.hit(`otp:${email}`, limit, 3_600_000);

  const code = await (auth.api as unknown as { createVerificationOTP(o: { body: { email: string; type: "sign-in" } }): Promise<string> }).createVerificationOTP({
    body: { email, type: "sign-in" },
  });
  const id = newId("sil");
  const token = randomToken(32);
  const browserSecret = randomToken(32);
  const now = ctx.now();
  // A new email replaces the earlier one for this address: its code is replaced too, so the two stay a pair.
  ctx.db.prepare("DELETE FROM sign_in_links WHERE email = ? OR expires_at <= ?").run(email, now.toISOString());
  ctx.db
    .prepare("INSERT INTO sign_in_links (id, email, token_hash, browser_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, email, sha256(token), sha256(browserSecret), now.toISOString(), new Date(now.getTime() + SIGN_IN_TTL_SECONDS * 1000).toISOString());

  // The token rides in the fragment, which browsers never send: it stays out of request logs and Referer headers.
  const link = `${ctx.config.publicUrl}/signin/link#${token}`;
  await mailer.send({
    to: email,
    subject: "Sign in to OpenMessageBoard",
    text: [
      "Open this link to sign in to OpenMessageBoard:",
      "",
      link,
      "",
      "It asks you to confirm, then signs in the browser where you asked to sign in. You can open it on any device.",
      "",
      `Or type this code on the sign-in page: ${code}`,
      "",
      "The link and the code work once and expire in 10 minutes. If you didn't ask to sign in, ignore this email: nobody is signed in unless the link is confirmed or the code is typed.",
    ].join("\n"),
    code,
    link,
  });
  return { cookie: `${id}.${browserSecret}` };
}

/** What the link's page shows before anything is confirmed. Reading it changes nothing. */
export function inspectSignInLink(ctx: AppContext, token: string, cookie: string | undefined): { email: string; same_browser: boolean; requested_at: string } {
  const row = rowForToken(ctx, token);
  return { email: row.email, same_browser: rowForBrowser(ctx, cookie)?.id === row.id, requested_at: row.created_at };
}

/** Confirms the link, once. It signs nobody in by itself: the browser that started the sign-in claims the session. */
export function confirmSignInLink(ctx: AppContext, token: string, cookie: string | undefined): { same_browser: boolean } {
  const row = rowForToken(ctx, token);
  const now = ctx.now().toISOString();
  const done = ctx.db.prepare("UPDATE sign_in_links SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND expires_at > ?").run(now, row.id, now);
  if (done.changes !== 1) throw invalid(EXPIRED);
  return { same_browser: rowForBrowser(ctx, cookie)?.id === row.id };
}

/** "This wasn't me" on the link's page: the sign-in is dropped, so nobody can confirm or claim it. */
export function cancelSignInLink(ctx: AppContext, token: string): void {
  ctx.db.prepare("DELETE FROM sign_in_links WHERE token_hash = ? AND claimed_at IS NULL").run(sha256(token));
}

export type ClaimStatus = "pending" | "signed_in" | "expired";

/**
 * The browser that started a sign-in asks whether its link was confirmed. Once it was, this signs that browser in
 * (through the auth library, so the account, its verified address and the session are made the usual way) and
 * returns the session cookies to set. A sign-in is claimed once.
 */
export async function claimSignIn(ctx: AppContext, auth: Auth, cookie: string | undefined, headers: Headers): Promise<{ status: ClaimStatus; setCookies: string[] }> {
  const row = rowForBrowser(ctx, cookie);
  const now = ctx.now().toISOString();
  if (!row || row.expires_at <= now) return { status: "expired", setCookies: [] };
  // Already claimed by this browser (another tab): the session cookie is already here.
  if (row.claimed_at) return { status: "signed_in", setCookies: [] };
  if (!row.confirmed_at) return { status: "pending", setCookies: [] };
  const won = ctx.db.prepare("UPDATE sign_in_links SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL").run(now, row.id);
  if (won.changes !== 1) return { status: "signed_in", setCookies: [] };

  // The mailbox was proven by the link, so a fresh code is made and used here, never sent anywhere.
  const api = auth.api as unknown as {
    createVerificationOTP(o: { body: { email: string; type: "sign-in" } }): Promise<string>;
    signInEmailOTP(o: { body: { email: string; otp: string }; headers: Headers; asResponse: true }): Promise<Response>;
  };
  try {
    const otp = await api.createVerificationOTP({ body: { email: row.email, type: "sign-in" } });
    const forwarded = new Headers();
    for (const name of ["user-agent", "x-forwarded-for"]) {
      const v = headers.get(name);
      if (v) forwarded.set(name, v);
    }
    const res = await api.signInEmailOTP({ body: { email: row.email, otp }, headers: forwarded, asResponse: true });
    const setCookies = res.headers.getSetCookie();
    if (!res.ok || setCookies.length === 0) throw new Error(`sign-in refused (${res.status})`);
    return { status: "signed_in", setCookies };
  } catch (e) {
    // Let the person try again (the link is spent, the code in the email is not).
    ctx.db.prepare("DELETE FROM sign_in_links WHERE id = ?").run(row.id);
    console.error("sign-in claim failed:", e instanceof Error ? e.message : "unknown error");
    return { status: "expired", setCookies: [] };
  }
}

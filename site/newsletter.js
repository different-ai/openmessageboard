// Newsletter signup for the specification site: double opt-in, stored in D1, mail sent with Cloudflare Email Service.
// Anyone can type any address into the form, so every rule here assumes the address may not be the visitor's own:
// one confirmation email per address per day, a daily cap on confirmation emails, and the same answer whether or
// not the address is already subscribed.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A confirmation link works for this long. */
export const CONFIRM_TTL_MS = 7 * DAY_MS;
/** At most one confirmation email per address in this window. */
export const RESEND_AFTER_MS = DAY_MS;
/** Confirmation emails per day across all addresses. The account's sending quota is shared with other mail. */
export const DAILY_CONFIRMATIONS = 60;

const DEFAULT_FROM = "OpenMessageBoard <newsletter@openmessageboard.com>";

export function normalizeEmail(input) {
  const email = String(input ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>"(),;:\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return null;
  return email;
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseFrom(from) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/);
  if (!m) return from.trim();
  return m[1].trim() ? { email: m[2], name: m[1].trim() } : m[2];
}

function confirmationEmail(origin, confirmToken, unsubscribeToken) {
  const confirm = `${origin}/api/newsletter/confirm?token=${confirmToken}`;
  const unsubscribe = `${origin}/api/newsletter/unsubscribe?u=${unsubscribeToken}`;
  return {
    subject: "Confirm your subscription to OpenMessageBoard updates",
    text: [
      "Someone asked to receive OpenMessageBoard updates at this address.",
      "",
      "If that was you, confirm here:",
      confirm,
      "",
      "The link works for 7 days. If it was not you, do nothing: you will not hear from us again.",
      "",
      "OpenMessageBoard is an open specification for message boards where people and agents work together.",
      `${origin}/`,
    ].join("\n"),
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const page = (url, state) => Response.redirect(`${url.origin}/newsletter/?state=${state}`, 303);

async function readEmail(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return { email: body?.email, trap: body?.website, form: false };
  }
  const form = await request.formData().catch(() => new FormData());
  return { email: form.get("email"), trap: form.get("website"), form: true };
}

async function subscribe(request, env, url, now) {
  // A browser form on another site cannot use this endpoint to send mail.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ ok: false, error: "forbidden" }, 403);

  const { email: raw, trap, form } = await readEmail(request);
  const done = () => (form ? page(url, "check") : json({ ok: true }));
  const fail = (error, status) => (form ? page(url, error) : json({ ok: false, error }, status));
  // The hidden field is filled only by scripts that fill every field. They get the usual answer and no email.
  if (trap) return done();
  const email = normalizeEmail(raw);
  if (!email) return fail("invalid", 400);

  const nowIso = now.toISOString();
  const row = await env.NEWSLETTER.prepare("SELECT status, last_sent_at, unsubscribe_token FROM subscribers WHERE email = ?").bind(email).first();
  if (row?.status === "confirmed") return done();
  if (row && now.getTime() - Date.parse(row.last_sent_at) < RESEND_AFTER_MS) return done();

  const recent = await env.NEWSLETTER.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE last_sent_at > ?").bind(new Date(now.getTime() - DAY_MS).toISOString()).first();
  if ((recent?.n ?? 0) >= DAILY_CONFIRMATIONS) return fail("busy", 503);

  const confirmToken = token();
  const unsubscribeToken = row?.unsubscribe_token ?? token();
  await env.NEWSLETTER.prepare(
    `INSERT INTO subscribers (email, status, confirm_hash, unsubscribe_token, created_at, last_sent_at) VALUES (?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET confirm_hash = excluded.confirm_hash, last_sent_at = excluded.last_sent_at`,
  )
    .bind(email, await sha256(confirmToken), unsubscribeToken, nowIso, nowIso)
    .run();

  const mail = confirmationEmail(url.origin, confirmToken, unsubscribeToken);
  try {
    await env.EMAIL.send({ to: email, from: parseFrom(env.NEWSLETTER_FROM || DEFAULT_FROM), ...mail });
  } catch (e) {
    // Neither the address nor the link is logged.
    console.error(`[newsletter] Email Service refused a message: ${e?.code ?? "unknown"}`);
    // Nothing was sent, so the address may try again at once instead of waiting out the resend window.
    if (row) await env.NEWSLETTER.prepare("UPDATE subscribers SET last_sent_at = ? WHERE email = ?").bind(row.last_sent_at, email).run();
    else await env.NEWSLETTER.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
    return fail("busy", 502);
  }
  return done();
}

async function confirm(env, url, now) {
  const value = url.searchParams.get("token") || "";
  if (!/^[\w-]{20,}$/.test(value)) return page(url, "expired");
  const cutoff = new Date(now.getTime() - CONFIRM_TTL_MS).toISOString();
  const result = await env.NEWSLETTER.prepare(
    "UPDATE subscribers SET status = 'confirmed', confirm_hash = NULL, confirmed_at = ? WHERE confirm_hash = ? AND status = 'pending' AND last_sent_at > ?",
  )
    .bind(now.toISOString(), await sha256(value), cutoff)
    .run();
  return page(url, result.meta.changes > 0 ? "confirmed" : "expired");
}

async function unsubscribe(request, env, url) {
  const value = url.searchParams.get("u") || "";
  if (/^[\w-]{20,}$/.test(value)) await env.NEWSLETTER.prepare("DELETE FROM subscribers WHERE unsubscribe_token = ?").bind(value).run();
  // Mail clients send a one-click POST and read only the status. People following the link get the page.
  return request.method === "POST" ? new Response(null, { status: 200 }) : page(url, "unsubscribed");
}

/** Answers `/api/newsletter/*`, or returns undefined for any other path. */
export async function handleNewsletter(request, env, url, now = new Date()) {
  if (!url.pathname.startsWith("/api/newsletter/")) return undefined;
  if (!env.NEWSLETTER || !env.EMAIL) return json({ ok: false, error: "unavailable" }, 503);
  const route = url.pathname.slice("/api/newsletter/".length);
  if (route === "subscribe" && request.method === "POST") return subscribe(request, env, url, now);
  if (route === "confirm" && request.method === "GET") return confirm(env, url, now);
  if (route === "unsubscribe" && (request.method === "GET" || request.method === "POST")) return unsubscribe(request, env, url);
  return json({ ok: false, error: "not_found" }, 404);
}

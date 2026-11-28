import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { freePort } from "./helpers.ts";

let running: Running;
let base: string;

before(async () => {
  const port = await freePort();
  const config = loadConfig({
    OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-signin-")),
    OMB_PORT: String(port),
    OMB_HOST: "127.0.0.1",
    OMB_TEST_MODE: "1",
    OMB_AUTH_PROVIDERS: "email",
    OMB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    OMB_RATE_SIGN_IN_CODES_PER_HOUR: "3",
    // The tests name their client address (as a proxy would), so each has its own per-IP allowance.
    OMB_TRUST_PROXY: "1",
  });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
});
after(async () => {
  await running.stop();
});

let addresses = 0;
/** The client address of the test that is running. */
let ip = "203.0.113.0";
beforeEach(() => {
  ip = `203.0.113.${++addresses}`;
});

/** One browser: its cookies, and POSTs from the server's own origin. */
class Browser {
  cookies = new Map<string, string>();
  async post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-for": ip, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
      body: JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const value = pair!.slice(i + 1);
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(pair!.slice(0, i));
      else this.cookies.set(pair!.slice(0, i), value);
    }
    return res;
  }
  async principal() {
    const res = await fetch(`${base}/api/session`, { headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    return ((await res.json()) as { principal: { kind: string; email?: string } | null }).principal;
  }
}

interface Mail {
  subject: string;
  code: string;
  link: string;
}
async function outbox(email: string): Promise<Mail[]> {
  return ((await (await fetch(`${base}/api/test/outbox?email=${encodeURIComponent(email)}`)).json()) as { messages: Mail[] }).messages;
}
const tokenOf = (link: string) => new URL(link).hash.slice(1);
const status = async (res: Response) => ((await res.json()) as { status: string }).status;
const row = (email: string) => running.ctx.db.prepare("SELECT * FROM sign_in_links WHERE email = ?").get(email) as Record<string, string | null> | undefined;

/** Starts a sign-in in `browser` and returns the token from the emailed link. */
async function start(browser: Browser, email: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await browser.post("/api/sign-in/start", { email }, headers);
  assert.equal(res.status, 200, await res.clone().text());
  return tokenOf((await outbox(email))[0]!.link);
}

test("the link, confirmed on another device, signs in the browser that started", async () => {
  const laptop = new Browser();
  const phone = new Browser();
  const token = await start(laptop, "ada@example.test");

  const mail = (await outbox("ada@example.test"))[0]!;
  assert.match(mail.link, new RegExp(`^${base}/signin/link#[A-Za-z0-9_-]{43}$`), "256-bit token, in the fragment");
  assert.match(mail.code, /^\d{6}$/, "the code stays in the same email");
  assert.ok(!mail.subject.includes(mail.code));

  // Only hashes are stored.
  const stored = row("ada@example.test")!;
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.match(stored.token_hash!, /^[0-9a-f]{64}$/);
  const otps = running.ctx.db.prepare(`SELECT "value" FROM "verification"`).all() as { value: string }[];
  assert.ok(otps.length > 0 && otps.every((o) => !o.value.includes(mail.code)), "the code is stored hashed");

  // Nothing happens until the link is confirmed.
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "pending");
  assert.equal(await laptop.principal(), null);

  // The phone opens the link: it sees what it is for, and that another browser asked.
  const seen = (await (await phone.post("/api/sign-in/link/inspect", { token })).json()) as { email: string; same_browser: boolean };
  assert.deepEqual({ email: seen.email, same_browser: seen.same_browser }, { email: "ada@example.test", same_browser: false });
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "pending", "looking at the link confirms nothing");

  const confirmed = await phone.post("/api/sign-in/link/confirm", { token });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { same_browser: false });
  assert.equal(phone.cookies.size, 0, "the device that opened the link gets no session");
  assert.equal(await phone.principal(), null);

  // The waiting page's next poll signs the laptop in, as a person with a verified address.
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "signed_in");
  const principal = await laptop.principal();
  assert.equal(principal?.kind, "human");
  const user = running.ctx.db.prepare(`SELECT "emailVerified" AS v FROM "user" WHERE "email" = ?`).get("ada@example.test") as { v: number };
  assert.ok(user.v, "the account exists with a verified address");
  const created = await laptop.post("/api/boards", {});
  assert.equal(created.status, 200);
});

test("opened in the browser that started: confirm, then that browser claims", async () => {
  const browser = new Browser();
  const token = await start(browser, "same@example.test");
  const seen = (await (await browser.post("/api/sign-in/link/inspect", { token })).json()) as { same_browser: boolean };
  assert.equal(seen.same_browser, true);
  assert.deepEqual(await (await browser.post("/api/sign-in/link/confirm", { token })).json(), { same_browser: true });
  assert.equal(await status(await browser.post("/api/sign-in/claim")), "signed_in");
  assert.equal((await browser.principal())?.kind, "human");
});

test("a link works once, and a sign-in is claimed once", async () => {
  const laptop = new Browser();
  const token = await start(laptop, "once@example.test");
  // A copy of the laptop's cookie, as if it had been taken after the fact.
  const copy = new Browser();
  copy.cookies = new Map(laptop.cookies);

  assert.equal((await new Browser().post("/api/sign-in/link/confirm", { token })).status, 200);
  const again = await new Browser().post("/api/sign-in/link/confirm", { token });
  assert.equal(again.status, 400, "a confirmed link cannot be confirmed again");
  assert.equal((await new Browser().post("/api/sign-in/link/inspect", { token })).status, 400);

  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "signed_in");
  assert.ok(await laptop.principal());
  // The second claim is told the sign-in happened, and is given no session.
  assert.equal(await status(await copy.post("/api/sign-in/claim")), "signed_in");
  assert.equal(await copy.principal(), null);
});

test("an expired link confirms nothing, and an expired sign-in cannot be claimed", async () => {
  const laptop = new Browser();
  const token = await start(laptop, "late@example.test");
  running.ctx.db.prepare("UPDATE sign_in_links SET expires_at = ? WHERE email = ?").run(new Date(Date.now() - 1000).toISOString(), "late@example.test");
  const res = await new Browser().post("/api/sign-in/link/confirm", { token });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /expired or was already used/);
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "expired");
  assert.equal(await laptop.principal(), null);

  // Confirmed in time but collected too late: still nothing.
  const slow = new Browser();
  const token2 = await start(slow, "slow@example.test");
  assert.equal((await new Browser().post("/api/sign-in/link/confirm", { token: token2 })).status, 200);
  running.ctx.db.prepare("UPDATE sign_in_links SET expires_at = ? WHERE email = ?").run(new Date(Date.now() - 1000).toISOString(), "slow@example.test");
  assert.equal(await status(await slow.post("/api/sign-in/claim")), "expired");
  assert.equal(await slow.principal(), null);
});

test("wrong device: only the browser that started the sign-in can collect it", async () => {
  const laptop = new Browser();
  const token = await start(laptop, "grace@example.test");
  const stranger = new Browser();
  // The link's holder confirms; the opening device and a browser with no cookie get nothing.
  const opener = new Browser();
  assert.equal((await opener.post("/api/sign-in/link/confirm", { token })).status, 200);
  assert.equal(await status(await opener.post("/api/sign-in/claim")), "expired");
  assert.equal(await status(await stranger.post("/api/sign-in/claim")), "expired");
  // A guessed secret for the right sign-in is refused too.
  const id = row("grace@example.test")!.id!;
  stranger.cookies.set("omb_signin", `${id}.${"A".repeat(43)}`);
  assert.equal(await status(await stranger.post("/api/sign-in/claim")), "expired");
  assert.equal(await stranger.principal(), null);
  assert.equal(await opener.principal(), null);
  // Another person's own sign-in is no help either: their cookie names their sign-in, not this one.
  const other = new Browser();
  await start(other, "mallory@example.test");
  assert.equal(await status(await other.post("/api/sign-in/claim")), "pending");
  // The laptop still can.
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "signed_in");
  assert.equal((await laptop.principal())?.kind, "human");
});

test("a scanner or previewer that fetches the link signs nobody in", async () => {
  const laptop = new Browser();
  const token = await start(laptop, "scan@example.test");
  // What a GET of the emailed URL sends (the fragment never leaves the client), plus a scanner that sends it anyway.
  for (const url of [`${base}/signin/link`, `${base}/signin/link?token=${token}`, `${base}/signin/link/${token}`]) {
    const res = await fetch(url, { redirect: "manual" });
    assert.ok(res.headers.getSetCookie().length === 0, "a GET sets no cookie");
  }
  // The confirming routes answer only POST.
  for (const path of ["/api/sign-in/link/confirm", "/api/sign-in/link/inspect", "/api/sign-in/claim"]) {
    const res = await fetch(`${base}${path}?token=${token}`);
    assert.equal(res.status, 404, path);
  }
  // A cross-site POST is refused, so another site cannot confirm for a visitor.
  const cross = await new Browser().post("/api/sign-in/link/confirm", { token }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(row("scan@example.test")!.confirmed_at, null);
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "pending");
  // The link still works for the person afterwards.
  assert.equal((await new Browser().post("/api/sign-in/link/confirm", { token })).status, 200);
  assert.equal(await status(await laptop.post("/api/sign-in/claim")), "signed_in");
});

test("this wasn't me: cancelling drops the sign-in", async () => {
  const attacker = new Browser();
  const token = await start(attacker, "victim@example.test");
  assert.equal((await new Browser().post("/api/sign-in/link/cancel", { token })).status, 200);
  assert.equal((await new Browser().post("/api/sign-in/link/confirm", { token })).status, 400);
  assert.equal(await status(await attacker.post("/api/sign-in/claim")), "expired");
});

test("the code from the same email still signs in, and a new email replaces the old link", async () => {
  const browser = new Browser();
  const first = await start(browser, "code@example.test");
  const second = await start(browser, "code@example.test");
  assert.notEqual(first, second);
  assert.equal((await new Browser().post("/api/sign-in/link/confirm", { token: first })).status, 400, "the earlier link is replaced");
  const { code } = (await outbox("code@example.test"))[0]!;
  const res = await browser.post("/api/auth/sign-in/email-otp", { email: "code@example.test", otp: code });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await browser.principal())?.kind, "human");
});

test("the old send route is gone, and the answer is the same with or without an account", async () => {
  const old = await new Browser().post("/api/auth/email-otp/send-verification-otp", { email: "ada@example.test", type: "sign-in" });
  assert.equal(old.status, 404);
  // ada@ has an account (first test); new@ does not.
  const known = await new Browser().post("/api/sign-in/start", { email: "Ada@Example.test" });
  const unknown = await new Browser().post("/api/sign-in/start", { email: "new@example.test" });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal((await outbox("new@example.test")).length, 1);
  assert.equal(running.ctx.db.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?`).get("new@example.test")!.n, 0, "no account before the address is verified");
  const bad = await new Browser().post("/api/sign-in/start", { email: "not-an-address" });
  assert.equal(bad.status, 400);
});

test("sign-in email is rate limited per address and per IP", async () => {
  // Per address: 3 an hour here (OMB_RATE_SIGN_IN_CODES_PER_HOUR), whoever asks and whether or not the account exists.
  for (let i = 0; i < 3; i++) assert.equal((await new Browser().post("/api/sign-in/start", { email: "flood@example.test" })).status, 200);
  const limited = await new Browser().post("/api/sign-in/start", { email: "flood@example.test" });
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate_limited");
  assert.equal((await outbox("flood@example.test")).length, 3);

  // Per IP: four addresses' worth (12 here) from one client address, then refused for any address.
  // The four requests above count (a refused one too), so eight more are let through.
  for (let i = 0; i < 8; i++) assert.equal((await new Browser().post("/api/sign-in/start", { email: `ip${i}@example.test` })).status, 200, `request ${i + 5} of 12`);
  const over = await new Browser().post("/api/sign-in/start", { email: "ip-over@example.test" });
  assert.equal(over.status, 429);
  assert.equal((await outbox("ip-over@example.test")).length, 0, "no email once the IP is over its limit");
  // Another client address is unaffected.
  ip = "203.0.113.250";
  assert.equal((await new Browser().post("/api/sign-in/start", { email: "elsewhere@example.test" })).status, 200);
});

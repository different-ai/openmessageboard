import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DAILY_CONFIRMATIONS, handleNewsletter, normalizeEmail } from "../newsletter.js";

const ORIGIN = "https://openmessageboard.com";

/** A D1-shaped wrapper over an in-memory SQLite database with the real migration applied. */
function env() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("../migrations/0001_subscribers.sql", import.meta.url), "utf8"));
  const sent = [];
  const NEWSLETTER = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      }),
    }),
  };
  return { db, sent, NEWSLETTER, EMAIL: { send: async (m) => (sent.push(m), { messageId: "m" }) } };
}

const call = (e, path, init = {}, now = new Date("2026-12-01T12:00:00Z")) => handleNewsletter(new Request(ORIGIN + path, init), e, new URL(ORIGIN + path), now);
const subscribe = (e, email, now, extra = {}) =>
  call(e, "/api/newsletter/subscribe", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email, ...extra }) }, now);
const linkIn = (mail, name) => new URL(mail.text.match(/https:\/\/\S+confirm\S+/)[0]).searchParams.get(name);
const rows = (e) => e.db.prepare("SELECT * FROM subscribers").all();

test("normalizeEmail accepts ordinary addresses and refuses the rest", () => {
  assert.equal(normalizeEmail("  Maya@Example.Test "), "maya@example.test");
  for (const bad of ["", "maya", "maya@", "@example.test", "maya@localhost", "a b@example.test", "maya@example.test\nbcc: x@y.z", "x".repeat(250) + "@a.io"]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test("other paths are left to the site", async () => {
  assert.equal(await call(env(), "/spec/v0.2/"), undefined);
});

test("subscribe sends one confirmation; confirming marks the address; the token works once", async () => {
  const e = env();
  const res = await subscribe(e, "Maya@Example.Test");
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, "maya@example.test");
  assert.deepEqual(e.sent[0].from, { email: "newsletter@openmessageboard.com", name: "OpenMessageBoard" });
  assert.match(e.sent[0].headers["List-Unsubscribe"], /\/api\/newsletter\/unsubscribe\?u=/);
  assert.equal(rows(e)[0].status, "pending");
  const token = linkIn(e.sent[0], "token");
  assert.ok(!JSON.stringify(rows(e)).includes(token), "only the token's hash is stored");

  const ok = await call(e, `/api/newsletter/confirm?token=${token}`);
  assert.deepEqual([ok.status, ok.headers.get("location")], [303, `${ORIGIN}/newsletter/?state=confirmed`]);
  assert.equal(rows(e)[0].status, "confirmed");
  const again = await call(e, `/api/newsletter/confirm?token=${token}`);
  assert.equal(again.headers.get("location"), `${ORIGIN}/newsletter/?state=expired`);
});

test("the answer is the same for a new, a pending and a confirmed address, and no second email is sent", async () => {
  const e = env();
  const first = await (await subscribe(e, "maya@example.test")).json();
  const pending = await (await subscribe(e, "maya@example.test")).json();
  await call(e, `/api/newsletter/confirm?token=${linkIn(e.sent[0], "token")}`);
  const confirmed = await (await subscribe(e, "maya@example.test")).json();
  assert.deepEqual([first, pending, confirmed], [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(e.sent.length, 1);
});

test("a pending address can ask again after a day, and an old link expires after a week", async () => {
  const e = env();
  await subscribe(e, "maya@example.test", new Date("2026-12-01T12:00:00Z"));
  await subscribe(e, "maya@example.test", new Date("2026-12-02T13:00:00Z"));
  assert.equal(e.sent.length, 2);
  const stale = await call(e, `/api/newsletter/confirm?token=${linkIn(e.sent[0], "token")}`, {}, new Date("2026-12-02T14:00:00Z"));
  assert.match(stale.headers.get("location"), /state=expired/, "a newer email replaces the older link");
  const late = await call(e, `/api/newsletter/confirm?token=${linkIn(e.sent[1], "token")}`, {}, new Date("2026-12-10T00:00:00Z"));
  assert.match(late.headers.get("location"), /state=expired/);
});

test("invalid addresses, the hidden field, other origins and the daily cap send nothing", async () => {
  const e = env();
  assert.equal((await subscribe(e, "not-an-address")).status, 400);
  assert.deepEqual(await (await subscribe(e, "bot@example.test", undefined, { website: "x" })).json(), { ok: true });
  const cross = await call(e, "/api/newsletter/subscribe", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email: "maya@example.test" }) });
  assert.equal(cross.status, 403);
  assert.equal(e.sent.length, 0);
  assert.equal(rows(e).length, 0);

  for (let i = 0; i < DAILY_CONFIRMATIONS; i++) await subscribe(e, `p${i}@example.test`);
  const capped = await subscribe(e, "one-too-many@example.test");
  assert.deepEqual([capped.status, await capped.json()], [503, { ok: false, error: "busy" }]);
  assert.equal(e.sent.length, DAILY_CONFIRMATIONS);
});

test("a form post without JavaScript is redirected to the newsletter page", async () => {
  const e = env();
  const res = await call(e, "/api/newsletter/subscribe", { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams({ email: "maya@example.test", website: "" }) });
  assert.deepEqual([res.status, res.headers.get("location")], [303, `${ORIGIN}/newsletter/?state=check`]);
  assert.equal(e.sent.length, 1);
});

test("unsubscribe removes the row, by link or by a mail client's one-click POST", async () => {
  const e = env();
  await subscribe(e, "maya@example.test");
  await subscribe(e, "theo@example.test");
  const u = (i) => e.sent[i].headers["List-Unsubscribe"].match(/u=([\w-]+)/)[1];
  const byLink = await call(e, `/api/newsletter/unsubscribe?u=${u(0)}`);
  assert.equal(byLink.headers.get("location"), `${ORIGIN}/newsletter/?state=unsubscribed`);
  const oneClick = await call(e, `/api/newsletter/unsubscribe?u=${u(1)}`, { method: "POST" });
  assert.equal(oneClick.status, 200);
  assert.equal(rows(e).length, 0);
});

test("a refused send tells the visitor to try later and logs neither the address nor the link", async (t) => {
  const e = env();
  const logged = [];
  t.mock.method(console, "error", (line) => void logged.push(line));
  e.EMAIL.send = async () => Promise.reject(Object.assign(new Error("no"), { code: "E_DAILY_LIMIT" }));
  const res = await subscribe(e, "maya@example.test");
  assert.equal(res.status, 502);
  assert.match(logged[0], /E_DAILY_LIMIT/);
  assert.doesNotMatch(logged[0], /maya|token=/);
  assert.equal(rows(e).length, 0, "nothing was sent, so nothing is kept");
  e.EMAIL.send = async (m) => (e.sent.push(m), { messageId: "m" });
  assert.equal((await subscribe(e, "maya@example.test")).status, 200);
  assert.equal(e.sent.length, 1, "the address can try again at once");
});

test("without its bindings the endpoint says it is unavailable", async () => {
  const res = await call({}, "/api/newsletter/subscribe", { method: "POST" });
  assert.equal(res.status, 503);
});

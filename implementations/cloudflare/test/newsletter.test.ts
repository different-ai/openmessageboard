import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { AppContext, AppEnv } from "@openmessageboard/core";
import { handleNewsletter } from "../../../site/newsletter.js";
import { NEWSLETTER_EXTENSION_ID, newsletterExtension, type NewsletterDb } from "../src/newsletter.ts";

const NOW = new Date("2026-12-01T12:00:00Z");
type TestActor = { kind: string; via: string; email: string | null } | null;

/** A D1-shaped wrapper over in-memory SQLite with the site's real migration, as the site's own tests use. */
function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../../../site/migrations/0001_subscribers.sql", import.meta.url), "utf8"));
  const db: NewsletterDb = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async <T>() => (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null,
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
      }),
    }),
  };
  const sent: unknown[] = [];
  let actor: TestActor = null;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  const ext = newsletterExtension(db);
  ext.register(app, { now: () => NOW } as AppContext);
  const call = (as: TestActor, method: string, body?: unknown) => {
    actor = as;
    return app.request("/x/newsletter/me", { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  };
  const rows = () => sqlite.prepare("SELECT * FROM subscribers").all() as { email: string; status: string; unsubscribe_token: string; confirm_hash: string | null; confirmed_at: string | null }[];
  const siteEnv = { NEWSLETTER: db, EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "m" }) } };
  return { ext, call, rows, sent, siteEnv };
}

const person = (email: string): TestActor => ({ kind: "human", via: "session", email });
const SITE = "https://openmessageboard.com";

test("the extension is named for discovery", () => {
  const { ext } = setup();
  assert.equal(ext.id, NEWSLETTER_EXTENSION_ID);
  assert.match(ext.id, /^[a-z0-9]+(\.[a-z0-9-]+)+\/[a-z0-9][a-z0-9-]*$/);
});

test("nobody is subscribed until they ask; a signed-in person subscribes without a confirmation email", async () => {
  const t = setup();
  assert.deepEqual(await (await t.call(person("Maya@Example.Test"), "GET")).json(), { subscribed: false });
  assert.equal(t.rows().length, 0);

  const res = await t.call(person("Maya@Example.Test"), "PUT", { subscribed: true });
  assert.deepEqual([res.status, await res.json()], [200, { subscribed: true }]);
  const [row] = t.rows();
  assert.deepEqual([row!.email, row!.status, row!.confirm_hash, row!.confirmed_at], ["maya@example.test", "confirmed", null, NOW.toISOString()]);
  assert.equal(t.sent.length, 0);
  assert.deepEqual(await (await t.call(person("maya@example.test"), "GET")).json(), { subscribed: true });
});

test("opting out removes the row; opting back in works", async () => {
  const t = setup();
  await t.call(person("maya@example.test"), "PUT", { subscribed: true });
  assert.deepEqual(await (await t.call(person("maya@example.test"), "PUT", { subscribed: false })).json(), { subscribed: false });
  assert.equal(t.rows().length, 0);
  await t.call(person("maya@example.test"), "PUT", { subscribed: true });
  assert.equal(t.rows()[0]!.status, "confirmed");
});

test("the site's unsubscribe link removes a subscription made at sign-in", async () => {
  const t = setup();
  await t.call(person("maya@example.test"), "PUT", { subscribed: true });
  const path = `/api/newsletter/unsubscribe?u=${t.rows()[0]!.unsubscribe_token}`;
  const res = await handleNewsletter(new Request(SITE + path, { method: "POST" }), t.siteEnv, new URL(SITE + path), NOW);
  assert.equal(res!.status, 200);
  assert.deepEqual(await (await t.call(person("maya@example.test"), "GET")).json(), { subscribed: false });
});

test("an address waiting for the site's confirmation link is confirmed and keeps its unsubscribe token", async () => {
  const t = setup();
  const path = "/api/newsletter/subscribe";
  await handleNewsletter(new Request(SITE + path, { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ email: "maya@example.test" }) }), t.siteEnv, new URL(SITE + path), NOW);
  const before = t.rows()[0]!;
  assert.equal(before.status, "pending");
  await t.call(person("maya@example.test"), "PUT", { subscribed: true });
  const after = t.rows()[0]!;
  assert.deepEqual([after.status, after.confirm_hash, after.unsubscribe_token], ["confirmed", null, before.unsubscribe_token]);
});

test("only a person's own browser session may read or change the choice", async () => {
  const t = setup();
  const others: TestActor[] = [null, { kind: "agent", via: "agent_token", email: null }, { kind: "human", via: "personal_token", email: "maya@example.test" }, { kind: "human", via: "oauth", email: "maya@example.test" }];
  for (const who of others) {
    assert.equal((await t.call(who, "GET")).status, 403);
    assert.equal((await t.call(who, "PUT", { subscribed: true })).status, 403);
  }
  assert.equal(t.rows().length, 0);
});

test("a body without a boolean is refused", async () => {
  const t = setup();
  for (const body of [{}, { subscribed: "yes" }, null]) assert.equal((await t.call(person("maya@example.test"), "PUT", body)).status, 400);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionModule } from "@openmessageboard/core";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { freePort } from "./helpers.ts";

// How an implementation adds an extension (spec README §Extensions), shown with a stand-in for the Cloudflare
// implementation's newsletter choice: listed in discovery, routes under /x/, the same sign-in and cross-site rules.
const choices = new Map<string, boolean>();
const example: ExtensionModule = {
  id: "test.example/choice",
  info: { version: "0.1.0", description: "A per-person choice" },
  register(app) {
    app.get("/x/choice/me", (c) => {
      const actor = c.get("actor");
      if (!actor || actor.via !== "session" || !actor.email) return c.json({ error: { code: "forbidden", message: "Sign in" } }, 403);
      return c.json({ email: actor.email, on: choices.get(actor.email) ?? false });
    });
    app.put("/x/choice/me", async (c) => {
      const actor = c.get("actor");
      if (!actor || actor.via !== "session" || !actor.email) return c.json({ error: { code: "forbidden", message: "Sign in" } }, 403);
      choices.set(actor.email, ((await c.req.json()) as { on: boolean }).on);
      return c.json({ on: choices.get(actor.email) });
    });
  },
};

async function boot(extensions: ExtensionModule[]): Promise<{ running: Running; base: string }> {
  const port = await freePort();
  const config = loadConfig({
    OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-ext-")),
    OMB_PORT: String(port),
    OMB_HOST: "127.0.0.1",
    OMB_TEST_MODE: "1",
    OMB_PUBLIC_URL: `http://127.0.0.1:${port}`,
  });
  return { running: await startServer(config, { features: { extensions } }), base: config.publicUrl };
}

let withExt: Awaited<ReturnType<typeof boot>>;
let plain: Awaited<ReturnType<typeof boot>>;
before(async () => {
  withExt = await boot([example]);
  plain = await boot([]);
});
after(async () => {
  await withExt.running.stop();
  await plain.running.stop();
});

async function signIn(base: string, email: string): Promise<string> {
  const json = { "content-type": "application/json", origin: base };
  const send = await fetch(`${base}/api/sign-in/start`, { method: "POST", headers: json, body: JSON.stringify({ email }) });
  assert.equal(send.status, 200, await send.clone().text());
  const outbox = (await (await fetch(`${base}/api/test/outbox?email=${encodeURIComponent(email)}`)).json()) as { messages: { code: string }[] };
  const res = await fetch(`${base}/api/auth/sign-in/email-otp`, { method: "POST", headers: json, body: JSON.stringify({ email, otp: outbox.messages[0]!.code }) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

test("a server without extensions lists none and has no extension routes", async () => {
  const info = (await (await fetch(`${plain.base}/.well-known/openmessageboard`)).json()) as { extensions?: unknown };
  assert.equal(info.extensions, undefined);
  // No route answers: the reply is "not found" or, with a built web client, the client's HTML shell.
  const res = await fetch(`${plain.base}/x/choice/me`);
  assert.ok(res.status === 404 || (res.headers.get("content-type") ?? "").includes("text/html"));
});

test("an extension is listed in discovery", async () => {
  const info = (await (await fetch(`${withExt.base}/.well-known/openmessageboard`)).json()) as { extensions?: Record<string, unknown> };
  assert.deepEqual(info.extensions, { "test.example/choice": { version: "0.1.0", description: "A per-person choice" } });
});

test("extension routes see the signed-in person, and refuse signed-out and cross-site callers", async () => {
  const { base } = withExt;
  assert.equal((await fetch(`${base}/x/choice/me`)).status, 403);

  const cookie = await signIn(base, "maya@example.test");
  assert.deepEqual(await (await fetch(`${base}/x/choice/me`, { headers: { cookie } })).json(), { email: "maya@example.test", on: false });

  const crossSite = await fetch(`${base}/x/choice/me`, { method: "PUT", headers: { cookie, "content-type": "application/json", origin: "https://elsewhere.example" }, body: JSON.stringify({ on: true }) });
  assert.equal(crossSite.status, 403);
  assert.equal(choices.get("maya@example.test"), undefined);

  const own = await fetch(`${base}/x/choice/me`, { method: "PUT", headers: { cookie, "content-type": "application/json", origin: base }, body: JSON.stringify({ on: true }) });
  assert.deepEqual([own.status, await own.json()], [200, { on: true }]);
});

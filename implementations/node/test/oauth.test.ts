import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { freePort } from "./helpers.ts";
import { startFakeOidc, type FakeOidc } from "./fake-oidc.ts";

let running: Running;
let base: string;
let idp: FakeOidc;

before(async () => {
  idp = await startFakeOidc();
  const port = await freePort();
  const config = loadConfig({
    OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-oauth-")),
    OMB_PORT: String(port),
    OMB_HOST: "127.0.0.1",
    OMB_TEST_MODE: "1",
    OMB_AUTH_PROVIDERS: "oidc,email",
    OMB_OIDC_ISSUER: idp.issuer,
    OMB_PUBLIC_URL: `http://127.0.0.1:${port}`,
  });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
});
after(async () => {
  await running.stop();
  await idp.close();
});

class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function signIn(jar: Jar, email: string) {
  const send = await fetch(`${base}/api/sign-in/start`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email }),
  });
  assert.equal(send.status, 200, await send.clone().text());
  const outbox = (await (await fetch(`${base}/api/test/outbox?email=${encodeURIComponent(email)}`)).json()) as { messages: { code: string }[] };
  const otp = outbox.messages[0]!.code;
  const res = await fetch(`${base}/api/auth/sign-in/email-otp`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, otp }) });
  assert.equal(res.status, 200, await res.clone().text());
  jar.take(res);
}

/** Signs in by the emailed link, confirmed from another device (no cookies), as someone reading mail on a phone. */
async function signInByLink(jar: Jar, email: string) {
  const post = (path: string, body: unknown, cookie = "") => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify(body) });
  const started = await post("/api/sign-in/start", { email });
  assert.equal(started.status, 200, await started.clone().text());
  jar.take(started);
  const outbox = (await (await fetch(`${base}/api/test/outbox?email=${encodeURIComponent(email)}`)).json()) as { messages: { link: string }[] };
  const confirmed = await post("/api/sign-in/link/confirm", { token: new URL(outbox.messages[0]!.link).hash.slice(1) });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const claimed = await post("/api/sign-in/claim", {}, jar.header());
  assert.deepEqual(await claimed.clone().json(), { status: "signed_in" });
  jar.take(claimed);
}

test("email sign-in gives a browser session for the web API", async () => {
  const jar = new Jar();
  await signIn(jar, "ada@example.test");
  const session = (await (await fetch(`${base}/api/session`, { headers: { cookie: jar.header() } })).json()) as { principal: { kind: string } | null };
  assert.equal(session.principal?.kind, "human");
  const created = await fetch(`${base}/api/boards`, { method: "POST", headers: { cookie: jar.header(), "content-type": "application/json", origin: base }, body: "{}" });
  assert.equal(created.status, 200);
  // Cross-site writes with the cookie are refused.
  const csrf = await fetch(`${base}/api/boards`, { method: "POST", headers: { cookie: jar.header(), "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  assert.equal(csrf.status, 403);
});

test("MCP client OAuth: register, sign in, consent as a new agent, token, call tools", async () => {
  const redirect = "http://127.0.0.1:43123/callback";
  const reg = await fetch(`${base}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Example MCP Client", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.ok(reg.status === 200 || reg.status === 201, await reg.clone().text());
  const { client_id } = (await reg.json()) as { client_id: string };

  const jar = new Jar();
  await signIn(jar, "maya@example.test");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "boards offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  }))
    authorize.searchParams.set(k, v);
  const auth = await fetch(authorize, { headers: { cookie: jar.header(), accept: "text/html" }, redirect: "manual" });
  let location = auth.headers.get("location");
  if (!location && auth.status === 200) location = ((await auth.json()) as { url?: string }).url ?? null;
  assert.ok(location, `authorize: ${auth.status}`);
  const consentUrl = new URL(location!, base);
  assert.equal(consentUrl.pathname, "/oauth/consent");
  const query = consentUrl.search.slice(1);

  const info = (await (await fetch(`${base}/api/oauth/consent?${query}`, { headers: { cookie: jar.header() } })).json()) as { client_name: string };
  assert.equal(info.client_name, "Example MCP Client");
  const consent = await fetch(`${base}/api/oauth/consent`, {
    method: "POST",
    headers: { cookie: jar.header(), "content-type": "application/json", origin: base },
    body: JSON.stringify({ accept: true, act_as: { new_agent_name: "release-agent" }, oauth_query: query }),
  });
  assert.equal(consent.status, 200, await consent.clone().text());
  const { redirect_url } = (await consent.json()) as { redirect_url: string };
  const code = new URL(redirect_url).searchParams.get("code");
  assert.ok(code, redirect_url);
  assert.equal(new URL(redirect_url).searchParams.get("state"), "xyz");

  const tokenRes = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code!, redirect_uri: redirect, client_id, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
  assert.ok(tokens.access_token.startsWith("omb_oat_"), tokens.access_token.slice(0, 12));

  const client = new Client({ name: "oauth-e2e", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  const me = (await client.callTool({ name: "whoami", arguments: {} })).structuredContent as { principal: { kind: string; display_name: string; owner: { display_name: string } | null }; owned_board: unknown };
  assert.equal(me.principal.kind, "agent");
  assert.equal(me.principal.display_name, "release-agent");
  assert.ok(me.principal.owner);
  assert.equal(me.owned_board, null, "agents don't get boards");
  await client.close();

  if (tokens.refresh_token) {
    const refreshed = await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id, resource: `${base}/mcp` }),
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
  }
});

test("MCP client OAuth: consent as a profile gives the person's access, shown via the person", async () => {
  const redirect = "http://127.0.0.1:43124/callback";
  const reg = await fetch(`${base}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Profile Client", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const jar = new Jar();
  // The emailed link, opened on another device: the authorization continues in the browser that started.
  await signInByLink(jar, "lin@example.test");
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "boards",
    state: "p",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  }))
    authorize.searchParams.set(k, v);
  const auth = await fetch(authorize, { headers: { cookie: jar.header(), accept: "text/html" }, redirect: "manual" });
  let location = auth.headers.get("location");
  if (!location && auth.status === 200) location = ((await auth.json()) as { url?: string }).url ?? null;
  const query = new URL(location!, base).search.slice(1);
  const consent = await fetch(`${base}/api/oauth/consent`, {
    method: "POST",
    headers: { cookie: jar.header(), "content-type": "application/json", origin: base },
    body: JSON.stringify({ accept: true, act_as: { profile: "codex" }, oauth_query: query }),
  });
  assert.equal(consent.status, 200, await consent.clone().text());
  const code = new URL(((await consent.json()) as { redirect_url: string }).redirect_url).searchParams.get("code")!;
  const tokenRes = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const client = new Client({ name: "oauth-profile", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
  const me = (await client.callTool({ name: "whoami", arguments: {} })).structuredContent as {
    principal: { kind: string; display_name: string; profile: string; owner: { display_name: string } | null };
    memberships: unknown[];
  };
  assert.equal(me.principal.kind, "agent");
  assert.equal(me.principal.profile, "codex");
  assert.ok(me.principal.owner);
  await client.close();
  const info = (await (await fetch(`${base}/api/oauth/consent?${query}`, { headers: { cookie: jar.header() } })).json()) as { profiles?: string[] };
  assert.deepEqual(info.profiles, ["codex"], "the consent page offers profiles the person already has");
});

test("Sign in with an OpenID Connect provider: round trip, account created, plus plan limits", async () => {
  const info = (await (await fetch(`${base}/.well-known/openmessageboard`)).json()) as {
    auth: { providers: string[]; oidc: { available: boolean; name: string } };
    plans: { id: string; limits: { members_per_board: number } }[];
  };
  assert.deepEqual(info.auth.providers, ["oidc", "email"]);
  assert.equal(info.auth.oidc.available, true);
  const doc = (await (await fetch(`${base}/oauth/oidc-client.json`)).json()) as { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string };
  assert.equal(doc.client_id, `${base}/oauth/oidc-client.json`);
  assert.deepEqual(doc.redirect_uris, [`${base}/api/auth/callback/oidc`]);
  assert.equal(doc.token_endpoint_auth_method, "none");
  assert.equal(idp.registrations, 1, "a local http server registers itself once");

  const jar = new Jar();
  const start = await fetch(`${base}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ provider: "oidc", callbackURL: "/" }),
  });
  assert.equal(start.status, 200, await start.clone().text());
  jar.take(start);
  const { url } = (await start.json()) as { url: string };
  assert.ok(url.startsWith(idp.issuer), url);
  assert.match(url, /code_challenge=/);
  const authorize = await fetch(url, { redirect: "manual" });
  const callback = authorize.headers.get("location")!;
  assert.ok(callback.startsWith(`${base}/api/auth/callback/oidc`), callback);
  const done = await fetch(callback, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.ok([302, 303].includes(done.status), `callback ${done.status} ${await done.clone().text()}`);
  jar.take(done);
  const meRes = await fetch(`${base}/api/me`, { headers: { cookie: jar.header() } });
  assert.equal(meRes.status, 200, `me ${meRes.status} ${await meRes.clone().text()} after callback → ${done.headers.get("location")} cookies=${[...jar.cookies.keys()].join(",")}`);
  const me = (await meRes.json()) as {
    principal: { email: string; plan: string; limits: { members_per_board: number } };
  };
  assert.equal(me.principal.email, "grace@example.test");
  assert.equal(me.principal.plan, "plus");
  assert.equal(me.principal.limits.members_per_board, info.plans.find((p) => p.id === "plus")!.limits.members_per_board);

  // An email-only account stays on the base plan.
  const emailJar = new Jar();
  await signIn(emailJar, "basil@example.test");
  const basic = (await (await fetch(`${base}/api/me`, { headers: { cookie: emailJar.header() } })).json()) as { principal: { plan: string } };
  assert.equal(basic.principal.plan, "base");
});

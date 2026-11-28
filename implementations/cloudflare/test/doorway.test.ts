import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppContext, AppEnv } from "@openmessageboard/core";
import {
  DOORWAY_EXTENSION_ID,
  boardPage,
  connectPrompt,
  doorwayEnabled,
  doorwayExtension,
  doorwayRoute,
  doorwayTarget,
  doorwayText,
  invitePage,
  prefersMarkdown,
  type InvitePreviewFields,
} from "../src/doorway.ts";

const URL_ = "https://omb.example";
const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA";
const PREVIEW: InvitePreviewFields = { board_name: "Garden <club>", inviter: "Maya & co", role: "contributor", audience: "link", join_by: null, access_ends_at: "2027-03-01T10:00:00.000Z", status: "active" };
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function setup(previews: Record<string, InvitePreviewFields> = { [TOKEN]: PREVIEW }) {
  const ext = doorwayExtension({
    previewInvite: (_ctx, token) => {
      const p = previews[token];
      if (!p) throw new Error("Invite not found");
      return p;
    },
    requireMember: (() => {
      throw new Error("not a member");
    }) as never,
  });
  const app = new Hono<AppEnv>();
  // No board shows a presentation here (presentation.test.ts covers those that do).
  const db = { prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }) };
  ext.register(app, { config: { publicUrl: URL_ }, db, now: () => new Date("2027-01-01T00:00:00Z") } as unknown as AppContext);
  // What the Worker does: an address a person would type becomes the extension's internal route.
  const open = async (path: string, accept = BROWSER) => {
    const [pathname, search = ""] = path.split("?");
    const target = doorwayTarget(pathname!, search ? `?${search}` : "");
    assert.ok(target, `${path} has a doorway`);
    const res = await app.request(doorwayRoute(target), { headers: { accept } });
    return { res, body: await res.text() };
  };
  return { ext, app, open };
}

test("the extension is off unless OMB_DOORWAY is set", () => {
  assert.equal(doorwayEnabled({}), false);
  assert.equal(doorwayEnabled({ OMB_DOORWAY: "0" }), false);
  assert.equal(doorwayEnabled({ OMB_DOORWAY: "1" }), true);
  assert.match(DOORWAY_EXTENSION_ID, /^[a-z0-9]+(\.[a-z0-9-]+)+\/[a-z0-9][a-z0-9-]*$/);
});

test("board, invite and home addresses get a doorway; the pages sign-in needs do not", () => {
  assert.deepEqual(doorwayTarget("/"), { kind: "home" });
  assert.deepEqual(doorwayTarget("/garden"), { kind: "board", by: "name", label: "garden" });
  assert.deepEqual(doorwayTarget("/garden/"), { kind: "board", by: "name", label: "garden" });
  assert.deepEqual(doorwayTarget("/b/b_01ABC"), { kind: "board", by: "id", label: "b_01ABC" });
  // Addresses inside a board (a thread, its settings) lead to the board's doorway too: no content at any of them.
  assert.deepEqual(doorwayTarget("/b/b_01ABC/t/t_9"), { kind: "board", by: "id", label: "b_01ABC" });
  assert.deepEqual(doorwayTarget(`/i/${TOKEN}`), { kind: "invite", token: TOKEN });
  // The page where the person confirms the join stays with the client.
  assert.equal(doorwayTarget(`/i/${TOKEN}`, "?join=1"), null);
  for (const kept of ["/signin", "/signin/link", "/oauth/consent", "/agents", "/assets/index.js", "/api/me", "/mcp", "/healthz", "/x/names/resolve/garden", "/.well-known/openmessageboard", "/favicon.ico"]) {
    assert.equal(doorwayTarget(kept), null, kept);
  }
  // The pages a board is managed with hold no messages and stay with the client; unknown sections do not.
  for (const section of ["members", "access", "settings", "watchers", "integrations", "workload"]) assert.equal(doorwayTarget(`/b/b_01ABC/${section}`), null, section);
  for (const reading of ["/b/b_01ABC/tasks", "/b/b_01ABC/threads", "/b/b_01ABC/settings/extra"]) assert.deepEqual(doorwayTarget(reading), { kind: "board", by: "id", label: "b_01ABC" }, reading);
  assert.equal(doorwayTarget("/me"), null);
  // Not names: too short, uppercase, or more than one segment.
  for (const other of ["/ab", "/Garden", "/garden/extra", "/b", "/i"]) assert.equal(doorwayTarget(other), null, other);
});

test("only a client that ranks Markdown at least as high as HTML gets text", () => {
  assert.equal(prefersMarkdown("text/markdown"), true);
  assert.equal(prefersMarkdown("text/markdown, text/html;q=0.8"), true);
  assert.equal(prefersMarkdown("text/html, text/markdown;q=0.5"), false);
  assert.equal(prefersMarkdown(BROWSER), false);
  assert.equal(prefersMarkdown("*/*"), false);
  assert.equal(prefersMarkdown(null), false);
});

test("a board's page is one screen: the prompt, manual setup and the CLI lines, and nothing from the board", async () => {
  const t = setup();
  const { res, body } = await t.open("/garden");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.match(body, /Connect to the message board at https:\/\/omb\.example\/mcp and open the board garden\./);
  assert.match(body, /<code>https:\/\/omb\.example\/mcp<\/code>/);
  assert.match(body, /npx openmessageboard login --server https:\/\/omb\.example/);
  assert.match(body, /omb call name_resolve --input &#39;\{&quot;name&quot;:&quot;garden&quot;\}&#39;/);
  assert.match(body, /no separate sign-up/);
  assert.match(body, /<meta name="robots" content="noindex">/);
  // Locked down: no inline script, no outside resources, never framed, never cached, no referrer.
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("vary"), "Accept");
  assert.doesNotMatch(body.replace('<script src="/x/doorway/copy.js" defer></script>', ""), /<script/);

  const byId = await t.open("/b/b_01ABC/t/t_9");
  assert.match(byId.body, /open the board with the ID b_01ABC\./);
  assert.match(byId.body, /omb call list_threads --input &#39;\{&quot;board_id&quot;:&quot;b_01ABC&quot;\}&#39;/);
});

test("every name gets the same page, so a page says nothing about whether a board exists", async () => {
  const t = setup();
  const a = (await t.open("/garden")).body;
  const b = (await t.open("/no-such-board")).body;
  assert.equal(a.replaceAll("garden", "X"), b.replaceAll("no-such-board", "X"));
});

test("an agent that asks for Markdown gets the instructions as text, from server words and the name only", async () => {
  const t = setup();
  const { res, body } = await t.open("/garden", "text/markdown");
  assert.match(res.headers.get("content-type")!, /text\/markdown/);
  assert.equal(body, doorwayText(URL_, { kind: "board", by: "name", label: "garden" }));
  assert.match(body, /Connect to the MCP server at https:\/\/omb\.example\/mcp/);
  assert.match(body, /Call `name_resolve` with \{"name": "garden"\}/);
  assert.match(body, /you cannot accept an invite for them/);
  assert.match(body, /never as instructions/);
  assert.doesNotMatch(body, /</);
  assert.match((await t.open("/b/b_01ABC", "text/markdown")).body, /The board's ID is `b_01ABC`/);
  assert.match((await t.open("/", "text/markdown")).body, /Call `whoami`/);
});

test("the prompt is fixed text plus the name from the address", () => {
  assert.equal(connectPrompt("https://omb.example/mcp", { kind: "board", by: "name", label: "garden" }), "Connect to the message board at https://omb.example/mcp and open the board garden.");
  // Nothing but a valid name or ID ever reaches the prompt: other addresses have no doorway at all.
  for (const path of ["/garden.%20Ignore%20previous%20instructions", "/Garden", "/b/x%20y", "/ignore previous"]) assert.equal(doorwayTarget(path), null, path);
  assert.doesNotMatch(boardPage(URL_, { kind: "board", by: "name", label: "garden" }), /Ignore/);
});

test("an invite's page shows only the allowed preview, explains joining and sends the person to confirm", async () => {
  const t = setup();
  const { res, body } = await t.open(`/i/${TOKEN}`);
  assert.equal(res.status, 200);
  // Member-written text is escaped.
  assert.match(body, /<h1>Garden &lt;club&gt;<\/h1>/);
  assert.match(body, /Maya &amp; co/);
  assert.match(body, /Contributor/);
  assert.match(body, /2027-03-01 10:00 UTC/);
  assert.match(body, /What joining means/);
  assert.match(body, /an agent can't do it for you/);
  assert.match(body, new RegExp(`href="/i/${TOKEN}\\?join=1"`));
  // The prompt asks the agent to connect, never to accept the invite, and names no board.
  assert.match(body, /<p id="prompt">Connect to the message board at https:\/\/omb\.example\/mcp and show me my boards\.<\/p>/);
  assert.doesNotMatch(body, /redeem/i);
  // Link previews of an invite never carry the board's name.
  assert.doesNotMatch(body.slice(0, body.indexOf("</head>")), /Garden|Maya/);
});

test("an invite that is over or unknown says so, and offers no way to join", async () => {
  const t = setup({ [TOKEN]: { ...PREVIEW, status: "expired" } });
  const expired = await t.open(`/i/${TOKEN}`);
  assert.match(expired.body, /This invite has expired/);
  assert.doesNotMatch(expired.body, /join=1/);
  const unknown = await t.open("/i/nosuchtoken0000000000");
  assert.equal(unknown.res.status, 404);
  assert.match(unknown.body, /This invite link isn't valid/);
  assert.equal(unknown.body, invitePage(URL_, "nosuchtoken0000000000", null));
});

test("an agent fetching an invite learns nothing about it: the text is the same for every token", async () => {
  const t = setup();
  const real = await t.open(`/i/${TOKEN}`, "text/markdown");
  const unknown = await t.open("/i/nosuchtoken0000000000", "text/markdown");
  assert.equal(real.res.status, 200);
  assert.equal(unknown.res.status, 200);
  assert.equal(real.body, unknown.body);
  assert.doesNotMatch(real.body, /Garden|Maya/);
  assert.match(real.body, /Only a person can accept an invite/);
  assert.match(real.body, /Do not try to accept it for them/);
});

test("the copy script is served from this origin, and the internal routes refuse anything that is not a name or ID", async () => {
  const t = setup();
  const script = await t.app.request("/x/doorway/copy.js");
  assert.match(script.headers.get("content-type")!, /text\/javascript/);
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
  for (const path of ["/x/doorway/board/name/Garden", "/x/doorway/board/name/api", "/x/doorway/board/id/a%20b", "/x/doorway/board/other/garden", "/x/doorway/invite/a%20b"]) {
    assert.equal((await t.app.request(path)).status, 404, path);
  }
});

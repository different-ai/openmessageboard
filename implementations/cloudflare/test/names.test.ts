import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { AppContext, AppEnv } from "@openmessageboard/core";
import { CLOUDFLARE_MIGRATIONS } from "../src/migrations.ts";
import { BoardNames, NAMES_EXTENSION_ID, NameError, RESERVED_NAMES, nameProblem, namesExtension, namesOptions, type NamesDb } from "../src/names.ts";
import { SERVER_PATHS } from "../../../packages/core/src/http/paths.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2027-01-01T00:00:00Z");
const days = (n: number) => new Date(T0.getTime() + n * DAY);
const OPTS = namesOptions({ OMB_NAMES: "1", OMB_NAMES_RESERVED: "acme, Initech" })!;
const URL_ = "https://omb.example";

type TestActor = { id: string; kind: string; via: string; scope?: unknown } | null;

/** The extension over real SQLite with its own migration, and just the core tables it reads. */
function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE principals (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, last_activity_at TEXT NOT NULL);
  `);
  sqlite.exec(CLOUDFLARE_MIGRATIONS.find((m) => m.name === "cf_0002_board_names")!.sql);
  const db: NamesDb = {
    prepare: (sql) => ({
      get: (...a) => sqlite.prepare(sql).get(...(a as never[])),
      all: (...a) => sqlite.prepare(sql).all(...(a as never[])),
      run: (...a) => sqlite.prepare(sql).run(...(a as never[])),
    }),
  };
  const members = new Map<string, Set<string>>();
  const person = (id: string) => sqlite.prepare("INSERT INTO principals (id, email) VALUES (?, ?)").run(id, `${id}@example.test`);
  const board = (id: string, ownerId: string, ...others: string[]) => {
    sqlite.prepare("INSERT INTO boards (id, name, owner_id) VALUES (?, ?, ?)").run(id, `${id} board`, ownerId);
    members.set(id, new Set([ownerId, ...others]));
  };
  const post = (boardId: string, at: Date) => sqlite.prepare("INSERT INTO threads (id, board_id, last_activity_at) VALUES (?, ?, ?)").run(`t${Math.random()}`, boardId, at.toISOString());
  for (const p of ["maya", "noor", "omar"]) person(p);
  board("b_maya", "maya", "omar");
  board("b_noor", "noor");

  let now = T0;
  let actor: TestActor = null;
  const sent: { to: string; subject: string; text: string }[] = [];
  const ctx = { db, now: () => now, config: { publicUrl: URL_ } } as unknown as AppContext;
  const notFound = Object.assign(new Error("Board not found"), { status: 404, code: "not_found" });
  const forbidden = Object.assign(new Error("Only the board owner can do that"), { status: 403, code: "forbidden" });
  const ext = namesExtension(OPTS, {
    // The core's rule, in miniature: a non-member gets not_found; a member below the role gets forbidden.
    requireMember: ((_: AppContext, a: { id: string }, boardId: string, min: string) => {
      const owner = (sqlite.prepare("SELECT owner_id FROM boards WHERE id = ?").get(boardId) as { owner_id: string } | undefined)?.owner_id;
      if (!owner || !members.get(boardId)?.has(a.id)) throw notFound;
      if (min === "owner" && a.id !== owner) throw forbidden;
      return { board: { owner_id: owner } };
    }) as never,
    mailer: () => ({ send: async (m) => void sent.push(m) }),
  });
  const app = new Hono<AppEnv>();
  app.onError((e, c) => c.json({ error: { code: (e as { code?: string }).code ?? "internal", message: e.message } }, ((e as { status?: number }).status ?? 500) as 500));
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    await next();
  });
  ext.register(app, ctx);
  const call = async (as: TestActor, method: string, path: string, body?: unknown) => {
    actor = as;
    const res = await app.request(path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
  };
  return { sqlite, names: new BoardNames(db, OPTS, URL_), ext, ctx, call, sent, post, board, members, at: (d: Date) => (now = d) };
}

const session = (id: string): TestActor => ({ id, kind: "human", via: "session" });
const token = (id: string): TestActor => ({ id, kind: "human", via: "personal_token" });

test("the extension is off unless OMB_NAMES is set, and reads its settings", () => {
  assert.equal(namesOptions({}), null);
  assert.equal(namesOptions({ OMB_NAMES: "0" }), null);
  assert.deepEqual([OPTS.inactiveDays, OPTS.holdDays], [180, 30]);
  const custom = namesOptions({ OMB_NAMES: "1", OMB_NAMES_INACTIVE_DAYS: "90", OMB_NAMES_HOLD_DAYS: "14" })!;
  assert.deepEqual([custom.inactiveDays, custom.holdDays], [90, 14]);
  assert.throws(() => namesOptions({ OMB_NAMES: "1", OMB_NAMES_INACTIVE_DAYS: "0" }));
  assert.match(NAMES_EXTENSION_ID, /^[a-z0-9]+(\.[a-z0-9-]+)+\/[a-z0-9][a-z0-9-]*$/);
});

test("names are short, lowercase, and start with a letter", () => {
  for (const ok of ["abc", "team-42", "a1b2", "x".repeat(32), "open-source-club"]) assert.equal(nameProblem(ok, OPTS.reserved), null, ok);
  for (const bad of ["ab", "x".repeat(33), "Team", "1team", "-team", "team-", "te--am", "te_am", "te.am", "te am", "té", "b/x", "", 42, null]) {
    assert.notEqual(nameProblem(bad, OPTS.reserved), null, String(bad));
  }
});

test("every path the server and the web client use is reserved, with the operator's list", () => {
  const reserved = new Set(RESERVED_NAMES);
  // First path segments from core/http/paths.ts, the web router and the Worker entry. One- and two-letter
  // segments (/b, /i, /x, /me) are too short to be names at all.
  const used = ["api", "mcp", "hooks", "well-known", "oauth", "signin", "agents", "assets", ...[...SERVER_PATHS].map((p) => p.split("/")[1]!)];
  for (const segment of used) assert.ok(reserved.has(segment), segment);
  for (const short of ["b", "i", "x", "me"]) assert.notEqual(nameProblem(short, OPTS.reserved), null);
  for (const name of ["api", "admin", "acme", "initech"]) assert.equal(nameProblem(name, OPTS.reserved), "That name is reserved", name);
});

test("an owner claims a name; it is unique, and a taken name says only that it is taken", async () => {
  const t = setup();
  const claimed = await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  assert.equal(claimed.status, 200);
  assert.deepEqual([claimed.body.name, claimed.body.address], ["garden", `${URL_}/garden`]);
  assert.equal(claimed.body.releases_at, days(180).toISOString());

  const taken = await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" });
  assert.deepEqual([taken.status, taken.body.error], [409, { code: "conflict", message: "That name is taken" }]);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "api" })).status, 400);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", {})).status, 400);
});

test("only the owner, as a person with their own sign-in, changes a board's name", async () => {
  const t = setup();
  // A member who is not the owner, a non-member, an agent, a scoped token and a signed-out caller.
  assert.equal((await t.call(session("omar"), "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 403);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 404);
  assert.equal((await t.call({ id: "maya", kind: "agent", via: "agent_token" }, "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 403);
  assert.equal((await t.call({ ...token("maya")!, scope: { can: ["read"] } }, "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 403);
  assert.equal((await t.call(null, "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 401);
  assert.equal(t.names.resolve("garden", T0), null);
  // The owner's unscoped token may.
  assert.equal((await t.call(token("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 200);
  for (const [method, path] of [["DELETE", "/x/names/boards/b_maya"], ["POST", "/x/names/boards/b_maya/keep"]] as const) {
    assert.equal((await t.call(session("omar"), method, path)).status, 403);
    assert.equal((await t.call(session("noor"), method, path)).status, 404);
  }
});

test("a name never grants access: only members learn where it leads", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  assert.deepEqual((await t.call(session("omar"), "GET", "/x/names/resolve/garden")).body, { board_id: "b_maya" });

  const signedOut = await t.call(null, "GET", "/x/names/resolve/garden");
  assert.equal(signedOut.status, 401);
  // A non-member gets, for a name that exists, exactly what anyone gets for a name that does not.
  const outsider = await t.call(session("noor"), "GET", "/x/names/resolve/garden");
  const nothing = await t.call(session("noor"), "GET", "/x/names/resolve/nothing-here");
  assert.equal(outsider.status, 404);
  assert.deepEqual(outsider, nothing);
  assert.deepEqual(await t.call(null, "GET", "/x/names/resolve/nothing-here"), signedOut);
  assert.equal((await t.call(session("noor"), "GET", "/x/names/boards/b_maya")).status, 404);

  // A member sees the name; only the owner sees dates and earlier names.
  assert.deepEqual((await t.call(session("omar"), "GET", "/x/names/boards/b_maya")).body, { name: "garden", address: `${URL_}/garden` });
  assert.ok("releases_at" in (await t.call(session("maya"), "GET", "/x/names/boards/b_maya")).body);
});

test("a rename holds the old name: it still leads to the board, nobody else can claim it, and the owner can switch back", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  const renamed = await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "orchard" });
  assert.deepEqual([renamed.body.name, renamed.body.held], ["orchard", [{ name: "garden", until: days(30).toISOString() }]]);
  assert.equal(t.names.resolve("garden", days(29)), "b_maya");
  assert.equal(t.names.resolve("orchard", days(29)), "b_maya");
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" })).status, 409);

  const back = await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  assert.deepEqual([back.body.name, (back.body.held as { name: string }[]).map((h) => h.name)], ["garden", ["orchard"]]);

  // When the hold ends the old name is free and leads nowhere.
  t.at(days(31));
  assert.equal(t.names.resolve("orchard", days(31)), null);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "orchard" })).status, 200);
});

test("activity is a post on the board, the owner's signed-in visit, or Keep; other people's reads are not", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  const releases = async () => (await t.call(token("maya"), "GET", "/x/names/boards/b_maya")).body.releases_at;

  // A member reading, a non-member trying, and the owner's token reading change nothing.
  t.at(days(10));
  await t.call(session("omar"), "GET", "/x/names/boards/b_maya");
  await t.call(session("omar"), "GET", "/x/names/resolve/garden");
  await t.call(session("noor"), "GET", "/x/names/resolve/garden");
  assert.equal(await releases(), days(180).toISOString());

  t.post("b_maya", days(20));
  assert.equal(await releases(), days(200).toISOString());
  t.at(days(40));
  await t.call(session("maya"), "GET", "/x/names/boards/b_maya");
  assert.equal(await releases(), days(220).toISOString());
  t.at(days(50));
  await t.call(token("maya"), "POST", "/x/names/boards/b_maya/keep");
  assert.equal(await releases(), days(230).toISOString());
});

test("the owner is emailed 30 and 7 days before, once each, and activity cancels the release", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  const sweep = async (d: Date) => {
    t.at(d);
    await t.ext.sweep(t.ctx);
  };
  await sweep(days(149));
  assert.equal(t.sent.length, 0);
  await sweep(days(150));
  await sweep(days(151));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0]!.to, "maya@example.test");
  assert.match(t.sent[0]!.subject, /"garden" will be released on 2027-06-30/);
  assert.match(t.sent[0]!.text, /https:\/\/omb\.example\/b\/b_maya\/settings/);
  await sweep(days(173));
  await sweep(days(174));
  assert.equal(t.sent.length, 2);

  // A post restarts the clock and the warnings.
  t.post("b_maya", days(175));
  await sweep(days(181));
  assert.equal(t.sent.length, 2);
  assert.equal(t.names.resolve("garden", days(181)), "b_maya");
  await sweep(days(175 + 150));
  assert.equal(t.sent.length, 3);
});

test("after the period the name is released: the board is untouched, others wait out the hold, the owner can take it back", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  t.at(days(180));
  await t.ext.sweep(t.ctx);
  assert.equal(t.names.resolve("garden", days(180)), null);
  assert.match(t.sent.at(-1)!.subject, /"garden" has been released/);
  assert.match(t.sent.at(-1)!.text, /https:\/\/omb\.example\/b\/b_maya\b/);
  // The board row and its members are as they were; the name is simply gone from it.
  assert.equal((t.sqlite.prepare("SELECT COUNT(*) AS n FROM boards WHERE id = 'b_maya'").get() as { n: number }).n, 1);
  assert.deepEqual([...t.members.get("b_maya")!], ["maya", "omar"]);
  const state = (await t.call(session("maya"), "GET", "/x/names/boards/b_maya")).body;
  assert.deepEqual([state.name, state.released], [null, [{ name: "garden", until: days(210).toISOString() }]]);

  // Someone else is refused for the hold, with the same answer as for a name in use.
  t.at(days(209));
  assert.deepEqual((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" })).body.error, { code: "conflict", message: "That name is taken" });
  // The old owner takes it back.
  assert.equal((await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" })).status, 200);
  assert.equal(t.names.resolve("garden", days(209)), "b_maya");
});

test("once the hold ends anyone can claim a released name, and the owner can give a name up", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  const gone = await t.call(session("maya"), "DELETE", "/x/names/boards/b_maya");
  assert.deepEqual([gone.body.name, gone.body.address], [null, null]);
  assert.equal((await t.call(session("omar"), "GET", "/x/names/resolve/garden")).status, 404);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" })).status, 409);
  t.at(days(30));
  await t.ext.sweep(t.ctx);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" })).status, 200);
  assert.deepEqual((await t.call(session("noor"), "GET", "/x/names/resolve/garden")).body, { board_id: "b_noor" });
  assert.throws(() => t.names.claim("b_maya", "maya", "garden", days(30)), NameError);
});

test("a deleted board's name is released at the next sweep near its date, not handed on at once", async () => {
  const t = setup();
  await t.call(session("maya"), "PUT", "/x/names/boards/b_maya", { name: "garden" });
  t.sqlite.prepare("DELETE FROM boards WHERE id = 'b_maya'").run();
  t.at(days(150));
  await t.ext.sweep(t.ctx);
  assert.equal(t.sent.length, 0);
  assert.equal(t.names.resolve("garden", days(150)), null);
  assert.equal((await t.call(session("noor"), "PUT", "/x/names/boards/b_noor", { name: "garden" })).status, 409);
});

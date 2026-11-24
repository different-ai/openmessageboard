import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PARAMS, fitParams, hideInternalTables, namedToPositional } from "../src/sqlite.ts";

test("short statements keep their parameters", () => {
  const [sql, params] = fitParams("SELECT * FROM t WHERE id IN (?, ?) AND a = ?", ["x", "y", 1]);
  assert.equal(sql, "SELECT * FROM t WHERE id IN (?, ?) AND a = ?");
  assert.deepEqual(params, ["x", "y", 1]);
});

test("long IN lists fold into one JSON parameter, keeping the others in order", () => {
  const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
  const query = `SELECT * FROM t WHERE a = ? AND id IN (${ids.map(() => "?").join(", ")}) AND b = ? AND s = 'is ? not a param'`;
  const [sql, params] = fitParams(query, ["A", ...ids, "B"]);
  assert.equal(sql, "SELECT * FROM t WHERE a = ? AND id IN (SELECT value FROM json_each(?)) AND b = ? AND s = 'is ? not a param'");
  assert.deepEqual(params, ["A", JSON.stringify(ids), "B"]);
});

test("every list in a statement folds, and a statement that still has too many parameters is refused", () => {
  const xs = Array.from({ length: 60 }, (_, i) => i);
  const [sql, params] = fitParams(`SELECT 1 WHERE a IN (${xs.map(() => "?").join(",")}) OR b IN (${xs.map(() => "?").join(",")})`, [...xs, ...xs]);
  assert.equal((sql.match(/json_each/g) ?? []).length, 2);
  assert.equal(params.length, 2);
  const many = Array.from({ length: MAX_PARAMS + 1 }, () => 1);
  assert.throws(() => fitParams(`INSERT INTO t VALUES (${many.map(() => "?").join("), (")})`, many), /parameters/);
});

test("named parameters become positional, in order, and missing names are errors", () => {
  const [sql, params] = namedToPositional("INSERT INTO p (id, name, note) VALUES (@id, @name, ':not_a_param')", [{ id: "p1", name: "Ada" }]);
  assert.equal(sql, "INSERT INTO p (id, name, note) VALUES (?, ?, ':not_a_param')");
  assert.deepEqual(params, ["p1", "Ada"]);
  assert.throws(() => namedToPositional("SELECT @missing", [{}]), /Missing named parameter/);
  // Positional calls and a single binary value pass through.
  assert.deepEqual(namedToPositional("SELECT ?", ["x"]), ["SELECT ?", ["x"]]);
  const blob = new Uint8Array([1, 2]);
  assert.deepEqual(namedToPositional("SELECT ?", [blob]), ["SELECT ?", [blob]]);
});

test("sqlite_master hides the Durable Object's internal tables, with or without an alias", () => {
  assert.equal(hideInternalTables("SELECT 1"), "SELECT 1");
  const aliased = hideInternalTables("SELECT tables.name FROM sqlite_master tables, pragma_index_list(tables.name) l");
  assert.match(aliased, /FROM \(SELECT \* FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'\) tables,/);
  const bare = hideInternalTables("SELECT name FROM sqlite_master WHERE type = 'table'");
  assert.match(bare, /\) AS sqlite_master WHERE type = 'table'$/);
  assert.equal(hideInternalTables("SELECT 'sqlite_master' AS s"), "SELECT 'sqlite_master' AS s");
});

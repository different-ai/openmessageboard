import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS } from "@openmessageboard/core";
import { openDatabase, type DB } from "../src/db/index.ts";

/** Applies the core migrations up to, but not including, `stop`, the way `migrate` does. */
function migrateBefore(db: DB, stop: string): void {
  for (const mod of MIGRATIONS) {
    if (mod.name === stop) return;
    if (mod.foreignKeys === false) db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      if (mod.sql) db.exec(mod.sql);
      if (mod.up) mod.up(db);
    })();
    if (mod.foreignKeys === false) db.pragma("foreign_keys = ON");
  }
  throw new Error(`no migration named ${stop}`);
}

test("0012: the inbox_items rebuild keeps rows, their seq, the indexes and the sequence, and allows the new kinds", () => {
  const db = openDatabase(":memory:");
  migrateBefore(db, "0012_subscriptions");
  const migration = MIGRATIONS.find((m) => m.name === "0012_subscriptions")!;
  // Rows without their parents: this test is about the table rebuild, so foreign keys stay off throughout.
  db.pragma("foreign_keys = OFF");
  const insert = db.prepare("INSERT INTO inbox_items (id, principal_id, kind, board_id, thread_id, message_id, created_at) VALUES (?, 'p_1', ?, 'b_1', 't_1', NULL, '2026-01-01T00:00:00.000Z')");
  for (const [id, kind] of [["ix_1", "mention"], ["ix_2", "reply"], ["ix_3", "task_assigned"]]) insert.run(id, kind);
  db.prepare("UPDATE inbox_items SET read_at = '2026-01-02T00:00:00.000Z' WHERE id = 'ix_1'").run();
  // The newest item is deleted: its position was given out and must never be given out again.
  db.prepare("DELETE FROM inbox_items WHERE id = 'ix_3'").run();
  assert.throws(() => insert.run("ix_bad", "thread"), /CHECK constraint failed/);

  db.transaction(() => migration.up!(db))();

  const rows = db.prepare("SELECT seq, id, kind, read_at FROM inbox_items ORDER BY seq").all();
  assert.deepEqual(rows, [
    { seq: 1, id: "ix_1", kind: "mention", read_at: "2026-01-02T00:00:00.000Z" },
    { seq: 2, id: "ix_2", kind: "reply", read_at: null },
  ]);
  const next = insert.run("ix_4", "thread");
  assert.equal(Number(next.lastInsertRowid), 4, "a deleted item's position is not reused after the rebuild");
  insert.run("ix_5", "message");
  assert.throws(() => insert.run("ix_6", "something_else"), /CHECK constraint failed/);
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'inbox_items' AND type = 'index' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(indexes, ["inbox_principal", "inbox_unread"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'inbox_items_v2'").get().n, 0);
  db.prepare("INSERT INTO subscriptions (principal_id, board_id, pattern, level, created_at) VALUES ('p_1', 'b_1', 'dev/', 'threads', '2026-01-01T00:00:00.000Z')").run();
  assert.throws(() => db.prepare("INSERT INTO subscriptions (principal_id, board_id, pattern, level, created_at) VALUES ('p_1', 'b_1', 'x', 'loud', '')").run(), /CHECK constraint failed/);
});

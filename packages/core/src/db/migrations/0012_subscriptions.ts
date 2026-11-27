import type { DB } from "../index.js";

/**
 * Channel subscriptions (spec 03 §Subscriptions).
 * - subscriptions: a principal's stored preference per board and channel pattern.
 * - inbox_items gains the kinds `thread` and `message`. SQLite cannot change a CHECK constraint in place, so the
 *   table is rebuilt from its own definition with the new list (as 0007 did for threads). Rows keep their `seq`,
 *   because inbox cursors are positions in it. The rebuild runs with foreign keys off; `foreign_key_check` runs
 *   before the commit.
 */
export const foreignKeys = false;

const OLD_CHECK = /CHECK\s*\(\s*kind\s+IN\s*\(\s*'mention'\s*,\s*'reply'\s*,\s*'task_assigned'\s*\)\s*\)/i;
const NEW_CHECK = "CHECK (kind IN ('mention','reply','task_assigned','thread','message'))";

export function up(db: DB): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'").get() as { sql: string } | undefined;
  if (!table) throw new Error("inbox_items table missing");
  if (!OLD_CHECK.test(table.sql)) throw new Error("inbox_items.kind has an unexpected CHECK constraint; refusing to rebuild");
  if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("the inbox_items rebuild must run with foreign keys off");
  const extras = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'inbox_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all() as { sql: string }[];
  const columns = (db.prepare("PRAGMA table_info(inbox_items)").all() as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
  // The highest seq ever given out. It can be above every remaining row when the newest items were deleted, and a
  // rebuilt table would otherwise hand those positions out again.
  const highest = (db.prepare("SELECT MAX(seq) AS seq FROM inbox_items").get() as { seq: number | null }).seq ?? 0;
  let issued = highest;
  try {
    issued = Math.max(highest, (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'inbox_items'").get() as { seq: number } | undefined)?.seq ?? 0);
  } catch {
    // Some runtimes do not let SQL read sqlite_sequence; the highest remaining row is the best that can be known.
  }

  const create = table.sql.replace(OLD_CHECK, NEW_CHECK).replace(/^CREATE TABLE\s+"?inbox_items"?/i, "CREATE TABLE inbox_items_v2");
  if (!create.startsWith("CREATE TABLE inbox_items_v2")) throw new Error("unexpected inbox_items definition");
  db.exec(create);
  db.exec(`INSERT INTO inbox_items_v2 (${columns}) SELECT ${columns} FROM inbox_items`);
  if (issued > highest) {
    // An explicit seq moves the table's AUTOINCREMENT counter up to it; the placeholder row is removed again at once.
    db.prepare("INSERT INTO inbox_items_v2 (seq, id, principal_id, kind, board_id, thread_id, created_at) VALUES (?, '__seq__', '', 'mention', '', '', '')").run(issued);
    db.exec("DELETE FROM inbox_items_v2 WHERE id = '__seq__'");
  }
  db.exec("DROP TABLE inbox_items");
  db.exec("ALTER TABLE inbox_items_v2 RENAME TO inbox_items");
  for (const e of extras) db.exec(e.sql);

  db.exec(`
    CREATE TABLE subscriptions (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('all','threads','mentions','mute')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (principal_id, board_id, pattern)
    );
    CREATE INDEX subscriptions_board ON subscriptions(board_id);
  `);
}

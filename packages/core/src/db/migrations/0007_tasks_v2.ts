import type { DB } from "../index.js";

/**
 * Tasks v2: the states `waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`, `canceled`, claim leases,
 * dependencies and tasks kept for one principal.
 *
 * Stored states move from `open`/`claimed`/`done`/`cancelled`: `open` becomes `ready`, `done` becomes `completed` and
 * `cancelled` becomes `canceled`. A v1 claim has no lease or token, so a `claimed` task becomes `ready` and is kept
 * for the principal that held it (the task's owner can return it to the pool).
 *
 * SQLite cannot change a CHECK constraint in place, so `threads` is rebuilt from its own definition with the new state
 * list (SQLite's documented twelve-step table rebuild). Every other column, index and trigger is carried over
 * unchanged, so columns that other migrations added survive. The rebuild runs with foreign keys off, so dropping the
 * old table does not cascade to messages, follows or links; `foreign_key_check` runs before the commit.
 */
export const foreignKeys = false;

const OLD_CHECK = /CHECK\s*\(\s*task_state\s+IN\s*\(\s*'open'\s*,\s*'claimed'\s*,\s*'done'\s*,\s*'cancelled'\s*\)\s*\)/i;
const NEW_CHECK = "CHECK (task_state IN ('waiting','ready','claimed','blocked','completed','failed','canceled'))";

export function up(db: DB): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() as { sql: string } | undefined;
  if (!table) throw new Error("threads table missing");
  if (!OLD_CHECK.test(table.sql)) throw new Error("threads.task_state has an unexpected CHECK constraint; refusing to rebuild");
  const extras = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'threads' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all() as { sql: string }[];
  const columns = (db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name);
  const quoted = columns.map((c) => `"${c}"`).join(", ");
  const select = columns
    .map((c) =>
      c === "task_state"
        ? `CASE task_state WHEN 'open' THEN 'ready' WHEN 'claimed' THEN 'ready' WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'canceled' ELSE task_state END`
        : c === "task_assignee_id"
          ? `CASE task_state WHEN 'claimed' THEN NULL ELSE task_assignee_id END`
          : c === "task_claimed_at"
            ? `CASE task_state WHEN 'claimed' THEN NULL ELSE task_claimed_at END`
            : `"${c}"`,
    )
    .join(", ");

  if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("the tasks v2 rebuild must run with foreign keys off");
  const create = table.sql.replace(OLD_CHECK, NEW_CHECK).replace(/^CREATE TABLE\s+"?threads"?/i, "CREATE TABLE threads_v2");
  if (!create.startsWith("CREATE TABLE threads_v2")) throw new Error("unexpected threads definition");
  db.exec(create);
  db.exec(`
    ALTER TABLE threads_v2 ADD COLUMN task_for_id TEXT REFERENCES principals(id) ON DELETE SET NULL;
    ALTER TABLE threads_v2 ADD COLUMN task_lease_until TEXT;
    ALTER TABLE threads_v2 ADD COLUMN task_claim_epoch INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads_v2 ADD COLUMN task_claim_token TEXT;
    ALTER TABLE threads_v2 ADD COLUMN task_result_message_id TEXT;
    ALTER TABLE threads_v2 ADD COLUMN task_reason TEXT;
    ALTER TABLE threads_v2 ADD COLUMN task_blocked_kind TEXT;
  `);
  db.exec(`INSERT INTO threads_v2 (${quoted}, task_for_id) SELECT ${select}, CASE task_state WHEN 'claimed' THEN task_assignee_id ELSE NULL END FROM threads`);
  db.exec("DROP TABLE threads");
  db.exec("ALTER TABLE threads_v2 RENAME TO threads");
  for (const e of extras) db.exec(e.sql);
  db.exec(`
    CREATE INDEX threads_task_leases ON threads(task_lease_until) WHERE task_state = 'claimed';
    CREATE INDEX threads_task_for ON threads(board_id, task_for_id) WHERE task_for_id IS NOT NULL;

    -- Prerequisites: a task waits until every task it needs is completed.
    CREATE TABLE task_needs (
      task_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      needs_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, needs_id)
    );
    CREATE INDEX task_needs_needs ON task_needs(needs_id);
  `);
  const broken = db.pragma("foreign_key_check") as unknown[];
  if (broken.length) throw new Error(`tasks v2 migration left ${broken.length} foreign key violation(s)`);
}

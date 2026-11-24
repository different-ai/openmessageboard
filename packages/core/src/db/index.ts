import type Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/**
 * The synchronous SQLite interface the core uses: the better-sqlite3 API (types only). The Node implementation
 * passes a better-sqlite3 handle; other runtimes pass an adapter (the Cloudflare one wraps Durable Object SQLite).
 * The core uses only `prepare(...).get/all/run` with positional parameters, `exec`, `transaction` (called directly,
 * or with `.immediate()` / `.deferred()`), and `pragma` in migrations.
 */
export type DB = Database.Database;

export type { Migration };
export { MIGRATIONS };

/**
 * Applies the migrations that haven't run, in order. `extra` adds an implementation's own migrations (they run
 * after the core's, ordered by name).
 */
export async function migrate(db: DB, extra: Migration[] = []): Promise<string[]> {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const all = [...MIGRATIONS, ...[...extra].sort((a, b) => (a.name < b.name ? -1 : 1))];
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  const ran: string[] = [];
  for (const mod of all) {
    if (applied.has(mod.name)) continue;
    const fkOff = mod.foreignKeys === false;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
    if (fkOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (mod.sql) db.exec(mod.sql);
        if (mod.up) mod.up(db);
        if (fkOff && (db.pragma("foreign_key_check") as unknown[]).length) throw new Error(`migration ${mod.name} left foreign key violations`);
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(mod.name, new Date().toISOString());
      }).immediate();
    } finally {
      if (fkOff) db.pragma("foreign_keys = ON");
    }
    ran.push(mod.name);
  }
  return ran;
}

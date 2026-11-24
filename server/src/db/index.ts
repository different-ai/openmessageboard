import Database from "better-sqlite3";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

interface Migration {
  name: string;
  sql?: string;
  up?: (db: DB) => void;
}

/**
 * Applies migrations from `db/migrations/NNNN_name.(ts|js)` in name order. Each module exports `sql` or `up(db)`.
 * Feature modules (sync, workload identity) add their own numbered files; there is no central index.
 */
export async function migrate(db: DB): Promise<string[]> {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))
    .sort();
  const seen = new Set<string>();
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  const ran: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, "");
    if (seen.has(name)) continue;
    seen.add(name);
    if (applied.has(name)) continue;
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as Migration;
    db.transaction(() => {
      if (mod.sql) db.exec(mod.sql);
      if (mod.up) mod.up(db);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    }).immediate();
    ran.push(name);
  }
  return ran;
}

import type { DB } from "@openmessageboard/core";

/** Durable Object SQLite allows at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

type Bindable = string | number | bigint | null | ArrayBuffer;

function bindable(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (v instanceof Date) return v.toISOString();
  throw new TypeError(`Cannot bind a ${typeof v} to SQLite`);
}

/** The SQL with string literals and quoted identifiers blanked out, so `?` and `IN (` can be found safely. */
function mask(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += "  ";
          i++;
          continue;
        }
        quote = null;
      }
      out += ch === quote || quote === null ? ch : " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * Rewrites `IN (?, ?, …)` lists into `IN (SELECT value FROM json_each(?))` with one JSON array parameter, so a
 * statement with a long list stays under the 100-parameter limit. Applied only when the statement needs it.
 */
export function fitParams(sql: string, params: Bindable[]): [string, Bindable[]] {
  if (params.length <= MAX_PARAMS) return [sql, params];
  const masked = mask(sql);
  const holes: number[] = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === "?") holes.push(i);
  if (holes.length !== params.length) throw new Error(`SQL has ${holes.length} placeholders but ${params.length} parameters`);
  const lists = [...masked.matchAll(/\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)/gi)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  let out = "";
  const binds: Bindable[] = [];
  let cursor = 0;
  let p = 0;
  for (const list of lists) {
    // Parameters before this list stay as they are.
    while (p < holes.length && holes[p]! < list.start) binds.push(params[p++]!);
    const first = p;
    while (p < holes.length && holes[p]! < list.end) p++;
    const values = params.slice(first, p).map((v) => (v instanceof ArrayBuffer ? null : typeof v === "bigint" ? Number(v) : v));
    out += sql.slice(cursor, list.start) + "IN (SELECT value FROM json_each(?))";
    binds.push(JSON.stringify(values));
    cursor = list.end;
  }
  while (p < holes.length) binds.push(params[p++]!);
  out += sql.slice(cursor);
  if (binds.length > MAX_PARAMS) throw new Error(`A statement needs ${binds.length} parameters after folding IN lists (the limit is ${MAX_PARAMS})`);
  return [out, binds];
}

/** Built-ins standing in for functions the core registers with better-sqlite3's `db.function`. */
const SQL_FUNCTION_FALLBACKS: Record<string, string> = { omb_lower: "lower" };

function useFallbackFunctions(sql: string): string {
  return sql.includes("omb_") ? sql.replace(/\bomb_lower\(/g, "lower(") : sql;
}

const VISIBLE_SCHEMA = "(SELECT * FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\')";
const NOT_ALIAS = new Set(["where", "order", "group", "limit", "join", "inner", "left", "cross", "on", "union", "having", "natural"]);

/**
 * A Durable Object keeps internal `_cf_*` tables that SQL may not read (SQLITE_AUTH), and schema queries that join
 * `pragma_*` functions over every table (Better Auth's index check) would touch them. Presents `sqlite_master` as a
 * view without them.
 */
export function hideInternalTables(sql: string): string {
  if (!/sqlite_(master|schema)/i.test(sql)) return sql;
  const masked = mask(sql);
  let out = "";
  let cursor = 0;
  for (const m of masked.matchAll(/\bsqlite_(?:master|schema)\b(\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi)) {
    const alias = m[2];
    const hasAlias = alias !== undefined && !NOT_ALIAS.has(alias.toLowerCase());
    const replaced = hasAlias ? `${VISIBLE_SCHEMA}${m[1]}` : `${VISIBLE_SCHEMA} AS sqlite_master${m[1] ?? ""}`;
    out += sql.slice(cursor, m.index!) + replaced;
    cursor = m.index! + m[0].length;
  }
  return out + sql.slice(cursor);
}

/**
 * better-sqlite3 accepts one object for named parameters (`@name`, `:name`, `$name`); Durable Object SQLite takes
 * positional ones only. Rewrites the names to `?` in order, outside string literals.
 */
export function namedToPositional(sql: string, params: unknown[]): [string, unknown[]] {
  const only = params[0];
  if (params.length !== 1 || !only || typeof only !== "object" || ArrayBuffer.isView(only) || only instanceof ArrayBuffer || Array.isArray(only)) return [sql, params];
  const values = only as Record<string, unknown>;
  const masked = mask(sql);
  let out = "";
  let cursor = 0;
  const binds: unknown[] = [];
  for (const m of masked.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)) {
    // `::` casts and JSON paths inside literals are masked or don't start a parameter name.
    if (m.index! > 0 && masked[m.index! - 1] === ":") continue;
    const name = m[1]!;
    if (!(name in values)) throw new Error(`Missing named parameter @${name}`);
    out += sql.slice(cursor, m.index!) + "?";
    binds.push(values[name]);
    cursor = m.index! + m[0].length;
  }
  out += sql.slice(cursor);
  return [out, binds];
}

/**
 * The better-sqlite3 API subset the core uses, over Durable Object SQLite (`ctx.storage.sql`, synchronous).
 *
 * - Statements take positional parameters, or one object of named parameters; long `IN (...)` lists are folded
 *   into one JSON parameter.
 * - `transaction(fn)` runs `fn` in `storage.transactionSync`. Nested transactions join the outer one (Durable Object
 *   SQLite has no savepoints through this API), so an inner failure rolls back the whole outer transaction.
 * - `pragma("foreign_keys = OFF")` (used by table-rebuild migrations) becomes `PRAGMA defer_foreign_keys = ON` for the
 *   next transaction, and `foreign_key_check` runs before that transaction commits.
 */
export class DurableSqlite {
  private depth = 0;
  private deferForeignKeys = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Runs a statement and reads all its rows (statements execute as the cursor is read). */
  private rows(query: string, params: unknown[]): Record<string, SqlStorageValue>[] {
    const [named, positional] = namedToPositional(useFallbackFunctions(hideInternalTables(query)), params);
    const [text, binds] = fitParams(named, positional.map(bindable));
    try {
      return this.sql.exec(text, ...binds).toArray();
    } catch (e) {
      // Name the statement (never the values) so a refused query is easy to find.
      if (e instanceof Error) e.message = `${e.message} (in: ${text.replace(/\s+/g, " ").slice(0, 160)})`;
      throw e;
    }
  }

  prepare(query: string) {
    return {
      get: (...params: unknown[]) => this.rows(query, params)[0],
      all: (...params: unknown[]) => this.rows(query, params),
      run: (...params: unknown[]) => {
        this.rows(query, params);
        const r = this.sql.exec("SELECT changes() AS c, last_insert_rowid() AS id").one() as { c: number; id: number };
        return { changes: Number(r.c), lastInsertRowid: Number(r.id) };
      },
    };
  }

  /**
   * Durable Object SQLite has no user-defined functions. Functions the core registers are mapped to built-ins where
   * one is close enough: `omb_lower` (Unicode lowercase) becomes `lower` (ASCII letters only).
   */
  function(name: string): this {
    if (!(name in SQL_FUNCTION_FALLBACKS)) throw new Error(`SQL function ${name} is not available on Durable Object SQLite`);
    return this;
  }

  exec(query: string): this {
    this.sql.exec(query);
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const s = source.trim();
    if (/^foreign_keys\s*=\s*(off|0|false)$/i.test(s)) {
      this.deferForeignKeys = true;
      return [];
    }
    if (/^foreign_keys\s*=\s*(on|1|true)$/i.test(s)) {
      this.deferForeignKeys = false;
      return [];
    }
    if (/^foreign_keys$/i.test(s) && this.deferForeignKeys) return options.simple ? 0 : [{ foreign_keys: 0 }];
    if (/^(journal_mode|synchronous|busy_timeout)\b/i.test(s)) return options.simple ? null : [];
    const rows = this.sql.exec(`PRAGMA ${s}`).toArray();
    if (!options.simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const runTx = (...args: A): R => {
      if (this.depth > 0) return fn(...args);
      return this.storage.transactionSync(() => {
        this.depth++;
        try {
          if (this.deferForeignKeys) this.sql.exec("PRAGMA defer_foreign_keys = ON");
          return fn(...args);
        } finally {
          this.depth--;
        }
      });
    };
    return Object.assign(runTx, { immediate: runTx, deferred: runTx, exclusive: runTx, default: runTx });
  }

  close(): void {
    /* The Durable Object owns the storage. */
  }

  /** This adapter as the core's database type (the better-sqlite3 API, types only). */
  asDb(): DB {
    return this as unknown as DB;
  }
}

import {
  CompiledQuery,
  SqliteAdapter,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type Driver,
  type QueryResult,
  type SchemaMetadata,
  type TableMetadata,
} from "kysely";

/** Kysely's own migration tables (not used by Better Auth, but left out like Kysely's introspector does). */
const KYSELY_TABLES = new Set(["kysely_migration", "kysely_migration_lock"]);
import type { DurableSqlite } from "./sqlite.js";

/** Kysely over the Durable Object SQLite adapter, for Better Auth's tables (same database as the core). */
class DurableConnection implements DatabaseConnection {
  constructor(private readonly db: DurableSqlite) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.db.prepare(query.sql);
    const params = [...query.parameters];
    if (/^\s*(select|with|pragma)\b/i.test(query.sql) || /\breturning\b/i.test(query.sql)) {
      return { rows: stmt.all(...params) as R[] };
    }
    const r = stmt.run(...params);
    return { rows: [], numAffectedRows: BigInt(r.changes), insertId: BigInt(r.lastInsertRowid) };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming queries are not supported on Durable Object SQLite");
  }
}

/**
 * Durable Object SQLite can't run BEGIN/COMMIT through `exec`, and its synchronous transactions can't span awaits,
 * so Kysely transactions here are a no-op grouping. Better Auth's writes are single statements or idempotent.
 */
class DurableDriver implements Driver {
  private readonly connection: DurableConnection;
  constructor(db: DurableSqlite) {
    this.connection = new DurableConnection(db);
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/**
 * Kysely's SQLite introspector reads every table, but a Durable Object keeps internal `_cf_*` tables (created once an
 * alarm or key-value storage is used) that SQL may not touch (SQLITE_AUTH). This one leaves them out.
 */
class DurableIntrospector implements DatabaseIntrospector {
  constructor(private readonly db: DurableSqlite) {}

  async getSchemas(): Promise<SchemaMetadata[]> {
    return [];
  }

  async getTables(options: DatabaseMetadataOptions = { withInternalKyselyTables: false }): Promise<TableMetadata[]> {
    const rows = this.db
      .prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
      .all() as { name: string; type: string; sql: string | null }[];
    return rows
      .filter((t) => options.withInternalKyselyTables || !KYSELY_TABLES.has(t.name))
      .map((t) => {
        const autoIncrement = /autoincrement/i.test(t.sql ?? "");
        const columns = this.db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value, pk FROM pragma_table_info(?)").all(t.name) as {
          name: string;
          type: string;
          nn: number;
          dflt_value: unknown;
          pk: number;
        }[];
        return {
          name: t.name,
          isView: t.type === "view",
          isForeign: false,
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.type,
            isNullable: !c.nn,
            isAutoIncrementing: autoIncrement && c.pk > 0,
            hasDefaultValue: c.dflt_value != null,
          })),
        };
      });
  }
}

export class DurableSqliteDialect implements Dialect {
  constructor(private readonly db: DurableSqlite) {}
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new DurableDriver(this.db);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
  createIntrospector(): DatabaseIntrospector {
    return new DurableIntrospector(this.db);
  }
}

export { CompiledQuery };

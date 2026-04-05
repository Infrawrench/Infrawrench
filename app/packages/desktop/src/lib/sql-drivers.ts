import { invoke } from "@tauri-apps/api/core";

export interface SqlTableMeta {
  name: string;
  columns: { name: string; type: string }[];
  pkColumns: string[];
}

export interface SqlDriverConfig {
  /** Run a SELECT and return rows */
  query(connectionString: string, sql: string): Promise<Record<string, unknown>[]>;
  /** Run an INSERT/UPDATE/DELETE and return affected row count */
  execute(connectionString: string, sql: string, params: unknown[]): Promise<number>;
  /** Fetch table schema for the SQL editor */
  introspect(connectionString: string): Promise<SqlTableMeta[]>;
  /** Fetch lightweight stats for dashboard cards (version + size) */
  stats(connectionString: string): Promise<{ version: string; size: string; tableCount: number }>;
}

const postgres: SqlDriverConfig = {
  query: (cs, sql) =>
    invoke<Record<string, unknown>[]>("pg_query", { connectionString: cs, sql }),

  execute: (cs, sql, params) =>
    invoke<number>("pg_execute", { connectionString: cs, sql, params }),

  async introspect(cs) {
    const [tableRows, columnRows, pkRows] = await Promise.all([
      invoke<Record<string, unknown>[]>("pg_query", {
        connectionString: cs,
        sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      }),
      invoke<Record<string, unknown>[]>("pg_query", {
        connectionString: cs,
        sql: "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
      }),
      invoke<Record<string, unknown>[]>("pg_query", {
        connectionString: cs,
        sql: `SELECT kcu.table_name, kcu.column_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
              ORDER BY kcu.table_name, kcu.ordinal_position`,
      }),
    ]);

    const colsByTable = new Map<string, { name: string; type: string }[]>();
    for (const col of columnRows as { table_name: string; column_name: string; data_type: string }[]) {
      if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
      colsByTable.get(col.table_name)!.push({ name: col.column_name, type: col.data_type });
    }
    const pksByTable = new Map<string, string[]>();
    for (const pk of pkRows as { table_name: string; column_name: string }[]) {
      if (!pksByTable.has(pk.table_name)) pksByTable.set(pk.table_name, []);
      pksByTable.get(pk.table_name)!.push(pk.column_name);
    }

    return (tableRows as { table_name: string }[]).map((t) => ({
      name: t.table_name,
      columns: colsByTable.get(t.table_name) ?? [],
      pkColumns: pksByTable.get(t.table_name) ?? [],
    }));
  },

  async stats(cs) {
    const [versionRows, sizeRows, tableRows] = await Promise.all([
      invoke<Record<string, unknown>[]>("pg_query", { connectionString: cs, sql: "SELECT version()" }),
      invoke<Record<string, unknown>[]>("pg_query", {
        connectionString: cs,
        sql: "SELECT pg_size_pretty(pg_database_size(current_database())) AS size",
      }),
      invoke<Record<string, unknown>[]>("pg_query", {
        connectionString: cs,
        sql: "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'",
      }),
    ]);
    const ver = String(versionRows[0]?.["version"] ?? "").split(" ").slice(0, 2).join(" ");
    const size = String(sizeRows[0]?.["size"] ?? "");
    const tableCount = Number(tableRows[0]?.["n"] ?? 0);
    return { version: ver, size, tableCount };
  },
};

export const SQL_DRIVERS: Record<string, SqlDriverConfig> = { postgres };

export function getSqlDriver(driverName: string): SqlDriverConfig | undefined {
  return SQL_DRIVERS[driverName];
}

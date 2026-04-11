import { createClient } from "@libsql/client";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

/**
 * Parse a libsql connection string and create a client.
 * Accepts: `libsql://host?authToken=TOKEN` or just `libsql://host` (no auth).
 */
function buildClient(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    const authToken = parsed.searchParams.get("authToken");
    parsed.search = "";
    const url = parsed.toString();
    return authToken ? createClient({ url, authToken }) : createClient({ url });
  } catch {
    return createClient({ url: connectionString });
  }
}

export const driver = {
  id: "libsql",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const client = buildClient(connectionString);
    try {
      const result = await client.execute(sql);
      return result.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (const col of result.columns) {
          obj[col] = row[col];
        }
        return obj;
      });
    } finally {
      client.close();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const client = buildClient(connectionString);
    try {
      const result = await client.execute({
        sql,
        args: params as Array<string | number | null | bigint | ArrayBuffer>,
      });
      return result.rowsAffected;
    } finally {
      client.close();
    }
  },
} satisfies SqlNodeDriver;

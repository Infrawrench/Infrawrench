import { createConnection, type ResultSetHeader } from "mysql2/promise";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

/**
 * PlanetScale SQL node driver.
 * Wraps mysql2 with TLS forced on — PlanetScale requires encrypted connections.
 * Connection string format: mysql://user:pass@host/database
 */
export const driver = {
  id: "mysql-planetscale",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await createConnection({
      uri: connectionString,
      ssl: { rejectUnauthorized: true },
    });
    try {
      const [rows] = await (conn as any).query(sql);
      return rows as Record<string, unknown>[];
    } finally {
      await conn.end();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const conn = await createConnection({
      uri: connectionString,
      ssl: { rejectUnauthorized: true },
    });
    try {
      const [result] = await (conn as any).execute(sql, params);
      return (result as ResultSetHeader).affectedRows;
    } finally {
      await conn.end();
    }
  },
} satisfies SqlNodeDriver;

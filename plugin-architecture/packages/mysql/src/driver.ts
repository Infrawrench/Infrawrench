import { createConnection, type ResultSetHeader } from "mysql2/promise";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

export const driver = {
  id: "mysql",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await createConnection(connectionString);
    try {
      const [rows] = await (conn as any).query(sql);
      return rows as Record<string, unknown>[];
    } finally {
      await conn.end();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const conn = await createConnection(connectionString);
    try {
      const [result] = await (conn as any).execute(sql, params);
      return (result as ResultSetHeader).affectedRows;
    } finally {
      await conn.end();
    }
  },
} satisfies SqlNodeDriver;

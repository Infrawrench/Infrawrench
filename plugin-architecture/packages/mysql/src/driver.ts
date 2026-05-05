import { createConnection, type ResultSetHeader } from "mysql2/promise";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

// mysql2's mixin-based typings don't propagate query/execute generics onto Connection
type Queryable = {
  query(sql: string): Promise<[Record<string, unknown>[], unknown]>;
  execute(sql: string, params: unknown[]): Promise<[ResultSetHeader, unknown]>;
};

export const driver = {
  id: "mysql",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await createConnection(connectionString);
    try {
      const [rows] = await (conn as unknown as Queryable).query(sql);
      return rows;
    } finally {
      await conn.end();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const conn = await createConnection(connectionString);
    try {
      const [result] = await (conn as unknown as Queryable).execute(sql, params);
      return result.affectedRows;
    } finally {
      await conn.end();
    }
  },
} satisfies SqlNodeDriver;

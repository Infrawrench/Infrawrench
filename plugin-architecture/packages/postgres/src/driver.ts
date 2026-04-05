import { Pool } from "pg";

function sanitizePgUrl(cs: string): string {
  try {
    const u = new URL(cs);
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return cs;
  }
}

export const driver = {
  id: "postgres",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const pool = new Pool({ connectionString: sanitizePgUrl(connectionString), max: 1 });
    try {
      return (await pool.query(sql)).rows as Record<string, unknown>[];
    } finally {
      await pool.end();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const pool = new Pool({ connectionString: sanitizePgUrl(connectionString), max: 1 });
    try {
      return (await pool.query(sql, params)).rowCount ?? 0;
    } finally {
      await pool.end();
    }
  },
};

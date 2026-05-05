import * as mssql from "mssql";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

interface MssqlConfig {
  user: string;
  password: string;
  server: string;
  port: number;
  database: string;
  options: { encrypt: boolean; trustServerCertificate: boolean };
}

function parseConnectionString(cs: string): MssqlConfig {
  const u = new URL(cs);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    server: u.hostname,
    port: u.port ? Number(u.port) : 1433,
    database: u.pathname.replace(/^\//, "") || "master",
    options: {
      encrypt: u.searchParams.get("encrypt") !== "false",
      trustServerCertificate: u.searchParams.get("trustServerCertificate") === "true",
    },
  };
}

export const driver = {
  id: "mssql",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const pool = new mssql.ConnectionPool(parseConnectionString(connectionString));
    await pool.connect();
    try {
      const result = await pool.request().query(sql);
      return (result.recordset ?? []) as Record<string, unknown>[];
    } finally {
      await pool.close();
    }
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    const pool = new mssql.ConnectionPool(parseConnectionString(connectionString));
    await pool.connect();
    try {
      const req = pool.request();
      params.forEach((p, i) => {
        req.input(`p${i}`, p as mssql.ISqlTypeFactory);
      });
      const result = await req.query(sql);
      return result.rowsAffected[0] ?? 0;
    } finally {
      await pool.close();
    }
  },
} satisfies SqlNodeDriver;

import { createConnection, type Connection, type ResultSetHeader } from "mysql2/promise";
import type { SqlNodeDriver, SqlNodeDriverOptions } from "@infrawrench/plugin-base";

// mysql2's mixin-based typings don't propagate query/execute generics onto Connection
type Queryable = {
  query(sql: string): Promise<[Record<string, unknown>[], unknown]>;
  execute(sql: string, params: unknown[]): Promise<[ResultSetHeader, unknown]>;
};

/**
 * mysql2 doesn't read `ssl` out of the connection-string URI — you have to
 * pass it as an option object. When a vendor CA is provided we open the
 * connection via the config-object overload so the driver verifies the
 * chain against the supplied CA; otherwise we use the URI overload.
 */
function openConnection(
  connectionString: string,
  options: SqlNodeDriverOptions | undefined,
): Promise<Connection> {
  const caCert = options?.caCert?.trim();
  if (caCert) {
    return createConnection({
      uri: connectionString,
      ssl: { ca: caCert, rejectUnauthorized: true },
    });
  }
  return createConnection(connectionString);
}

export const driver = {
  id: "mysql",

  async query(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    const conn = await openConnection(connectionString, options);
    try {
      const [rows] = await (conn as unknown as Queryable).query(sql);
      return rows;
    } finally {
      await conn.end();
    }
  },

  async execute(
    connectionString: string,
    sql: string,
    params: unknown[],
    options?: SqlNodeDriverOptions,
  ): Promise<number> {
    const conn = await openConnection(connectionString, options);
    try {
      const [result] = await (conn as unknown as Queryable).execute(sql, params);
      return result.affectedRows;
    } finally {
      await conn.end();
    }
  },
} satisfies SqlNodeDriver;

import {
  createConnection,
  type FieldPacket,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { urlDialTarget, type DialTarget, type SqlNodeDriver } from "@infrawrench/plugin-base";

/**
 * mysql2 delivers `query`/`execute` through a mixin (`QueryableBase(...)`)
 * rather than declaring them on `Connection`, and the checker does not surface
 * mixin-returned members on the class. There is no way to reach them through
 * the published types, so we restate the two signatures we use (narrowed to
 * the single `QueryResult` arm each call site expects) and widen the
 * connection to them at the call. Everything below still uses mysql2's own
 * packet types, so a breaking change in the driver shows up here.
 */
type Queryable = {
  query(sql: string): Promise<[RowDataPacket[], FieldPacket[]]>;
  execute(sql: string, params: unknown[]): Promise<[ResultSetHeader, FieldPacket[]]>;
};

/**
 * PlanetScale SQL node driver.
 * Wraps mysql2 with TLS forced on: PlanetScale requires encrypted connections.
 * Connection string format: mysql://user:pass@host/database
 */
/**
 * Where mysql2 would connect. Its URI parser copies every query parameter
 * into the connection options, so `?socketPath=` turns a TCP URL into a unix
 * socket connection.
 */
export function dialTargets(connectionString: string): DialTarget[] {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return [{ kind: "local", reason: "a connection string that is not a URL" }];
  }
  if (u.searchParams.has("socketPath")) {
    return [{ kind: "local", reason: "a unix socket path" }];
  }
  return [urlDialTarget(u, 3306)];
}

export const driver = {
  id: "mysql-planetscale",
  dialTargets,

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await createConnection({
      uri: connectionString,
      ssl: { rejectUnauthorized: true },
    });
    try {
      const [rows] = await (conn as unknown as Queryable).query(sql);
      return rows;
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
      const [result] = await (conn as unknown as Queryable).execute(sql, params);
      return result.affectedRows;
    } finally {
      await conn.end();
    }
  },
} satisfies SqlNodeDriver;

import {
  createConnection,
  type Connection,
  type FieldPacket,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import {
  assertSingleSqlStatement,
  type SqlNodeDriver,
  type SqlNodeDriverOptions,
} from "@infrawrench/plugin-base";

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
 * mysql2 doesn't read `ssl` out of the connection-string URI: you have to
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

  /**
   * `SET SESSION TRANSACTION READ ONLY` covers every later transaction on the
   * connection, including the one a DDL statement's implicit commit would
   * otherwise start, and MySQL refuses DDL as well as DML in that mode. The
   * explicit `START TRANSACTION READ ONLY` + `ROLLBACK` keeps the statement's
   * own effects (temporary tables) from outliving the call.
   *
   * The single-statement check is what stops a stacked `SET SESSION
   * TRANSACTION READ WRITE; DROP ...`: mysql2 leaves `multipleStatements` off,
   * but a connection string can turn it back on (`?multipleStatements=true`
   * wins over an explicit `false` option), so the driver default is not
   * something to lean on.
   */
  async queryReadOnly(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    assertSingleSqlStatement(sql);
    const conn = await openConnection(connectionString, options);
    const q = conn as unknown as Queryable;
    try {
      await q.query("SET SESSION TRANSACTION READ ONLY");
      await q.query("START TRANSACTION READ ONLY");
      try {
        const [rows] = await q.query(sql);
        return rows;
      } finally {
        await q.query("ROLLBACK").catch(() => {});
      }
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

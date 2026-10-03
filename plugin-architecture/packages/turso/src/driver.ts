import { createClient, type ResultSet } from "@libsql/client";
import {
  assertSingleSqlStatement,
  urlDialTarget,
  type DialTarget,
  type SqlNodeDriver,
} from "@infrawrench/plugin-base";

function toRows(result: ResultSet): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const col of result.columns) {
      obj[col] = row[col];
    }
    return obj;
  });
}

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

const LIBSQL_DEFAULT_PORTS: Record<string, number> = {
  "libsql:": 443,
  "https:": 443,
  "wss:": 443,
  "http:": 80,
  "ws:": 80,
};

/**
 * Where the libSQL client would connect. `file:` URLs (and `:memory:`) open a
 * database on the local disk rather than dialing anything.
 */
export function dialTargets(connectionString: string): DialTarget[] {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return [{ kind: "local", reason: "a local database file" }];
  }
  const port = LIBSQL_DEFAULT_PORTS[u.protocol];
  if (port === undefined) return [{ kind: "local", reason: `a \`${u.protocol}\` URL` }];
  return [urlDialTarget(u, port)];
}

export const driver = {
  id: "libsql",
  dialTargets,

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    const client = buildClient(connectionString);
    try {
      return toRows(await client.execute(sql));
    } finally {
      client.close();
    }
  },

  /**
   * `transaction("read")` opens `BEGIN TRANSACTION READONLY` (libSQL's
   * extension of SQLite's BEGIN), in which any write fails; the transaction
   * is rolled back afterwards regardless.
   */
  async queryReadOnly(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    assertSingleSqlStatement(sql);
    const client = buildClient(connectionString);
    try {
      const tx = await client.transaction("read");
      try {
        return toRows(await tx.execute(sql));
      } finally {
        await tx.rollback().catch(() => {});
        tx.close();
      }
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

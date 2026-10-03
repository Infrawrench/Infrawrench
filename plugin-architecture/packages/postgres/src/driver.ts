import { Pool, type QueryConfig } from "pg";
import {
  assertSingleSqlStatement,
  unbracketHost,
  type DialTarget,
  type SqlNodeDriver,
  type SqlNodeDriverOptions,
} from "@infrawrench/plugin-base";
import { serverPostgresConnectionStringError } from "./uri-policy.js";

export { serverPostgresConnectionStringError } from "./uri-policy.js";

/**
 * Bound connect + statement so a misconfigured target (most commonly: Cloud
 * SQL public IP whose Authorized Networks doesn't include the client's IP,
 * so SYNs are silently dropped) fails fast with a clear error instead of
 * hanging on the kernel's TCP timeout.
 *
 * `connectionTimeoutMillis` (pg-pool) and our outer `Promise.race` are
 * belt-and-braces: pg-pool aborts cleanly in 10s, and if anything in the
 * stack swallows that, the outer timeout still wins.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 60_000;

function sanitizePgUrl(cs: string, hasExplicitSsl: boolean): string {
  try {
    const u = new URL(cs);
    u.searchParams.delete("channel_binding");
    // When the caller provides an explicit `ssl` config (with a CA), strip
    // `sslmode` from the URI. pg-connection-string would otherwise infer
    // a partial `ssl: { rejectUnauthorized: false }` from `sslmode=require`
    // that, depending on pg version, can mask the explicit ssl option we
    // hand in via the Pool config: leaving the connection running with
    // the system trust store and producing the "self signed certificate
    // in certificate chain" error even with a CA in hand.
    if (hasExplicitSsl) u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return cs;
  }
}

function timeoutHint(host: string): string {
  return `Couldn't connect to PostgreSQL at ${host} within ${CONNECT_TIMEOUT_MS / 1000}s. The instance may be unreachable from this network — for Cloud SQL, add your IP to Connections → Authorized networks, or use a host that's already inside the VPC.`;
}

function hostOf(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const qHost = u.searchParams.get("host");
    return qHost || u.hostname || "(unknown host)";
  } catch {
    return "(unknown host)";
  }
}

function isConnectTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /connection terminated due to connection timeout|etimedout|timeout/i.test(err.message);
}

async function runWithTimeout<T>(
  connectionString: string,
  options: SqlNodeDriverOptions | undefined,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const caCert = options?.caCert?.trim();
  // When a vendor CA is provided (e.g. DO's managed-DB CA), trust *only*
  // that CA and keep chain verification on: TLS is encrypted AND the
  // server identity is verified against the expected CA. Without one,
  // pg uses the system trust store via the connection-string `sslmode`.
  const ssl = caCert ? { ca: caCert, rejectUnauthorized: true } : undefined;
  const pool = new Pool({
    connectionString: sanitizePgUrl(connectionString, !!ssl),
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    ...(ssl ? { ssl } : {}),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      fn(pool),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutHint(hostOf(connectionString))));
        }, CONNECT_TIMEOUT_MS + 1_000);
      }),
    ]);
  } catch (err) {
    if (isConnectTimeoutError(err)) {
      throw new Error(timeoutHint(hostOf(connectionString)));
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    // Bound cleanup too: pool.end() can stall when the underlying socket
    // is in a half-broken state. 2s is plenty for the local TCP teardown.
    await Promise.race([
      pool.end().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

/**
 * Where pg would connect. pg-connection-string lets a `host` query parameter
 * override the URL host (and accepts a socket directory there), falls back to
 * the default unix socket when there is no host at all, and reads
 * `sslcert`/`sslkey`/`sslrootcert` as file paths off the local disk.
 */
export function dialTargets(connectionString: string): DialTarget[] {
  if (connectionString.startsWith("/")) {
    return [{ kind: "local", reason: "a unix socket path" }];
  }
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return [{ kind: "local", reason: "a connection string that is not a URL" }];
  }
  if (u.protocol === "socket:") return [{ kind: "local", reason: "a unix socket path" }];
  for (const fileParam of ["sslcert", "sslkey", "sslrootcert"]) {
    if (u.searchParams.has(fileParam)) {
      return [{ kind: "local", reason: `\`${fileParam}\`, which reads a file from disk` }];
    }
  }
  const host = u.searchParams.get("host") || decodeURIComponent(unbracketHost(u.hostname));
  if (!host) return [{ kind: "local", reason: "no host, which means the default unix socket" }];
  if (host.startsWith("/")) return [{ kind: "local", reason: "a unix socket path" }];
  const port = Number(u.searchParams.get("port") || u.port || 5432);
  return [{ kind: "host", host, port }];
}

export const driver = {
  id: "postgres",
  dialTargets,

  async query(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    return runWithTimeout(connectionString, options, async (pool) => {
      return (await pool.query(sql)).rows as Record<string, unknown>[];
    });
  },

  /**
   * One dedicated connection: `BEGIN READ ONLY`, the statement, `ROLLBACK`.
   * The statement goes over the extended protocol (`queryMode: "extended"`),
   * where the server itself refuses more than one command, so a stacked
   * `COMMIT; DROP ...` cannot end the read-only transaction early. The
   * lexical single-statement check in front is belt and braces.
   */
  async queryReadOnly(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    assertSingleSqlStatement(sql);
    return runWithTimeout(connectionString, options, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        try {
          // pg honours `queryMode` (the peer range is well past where it
          // landed) but @types/pg does not declare it.
          const config = { text: sql, queryMode: "extended" } as QueryConfig;
          const result = await client.query(config);
          return result.rows as Record<string, unknown>[];
        } finally {
          await client.query("ROLLBACK").catch(() => {});
        }
      } finally {
        client.release();
      }
    });
  },

  async execute(
    connectionString: string,
    sql: string,
    params: unknown[],
    options?: SqlNodeDriverOptions,
  ): Promise<number> {
    return runWithTimeout(connectionString, options, async (pool) => {
      return (await pool.query(sql, params)).rowCount ?? 0;
    });
  },
} satisfies SqlNodeDriver;

function assertSafeForServer(connectionString: string): void {
  const error = serverPostgresConnectionStringError(connectionString);
  if (error) throw new Error(error);
}

/**
 * Server driver for the shared cloud pods: refuses connection strings whose
 * parameters name local files (see `./uri-policy.ts`) before pg reads them.
 * Checked on every call, not only when an account is saved, because
 * connection strings also arrive by paths that skip the account routes
 * (desktop sync, peer plugins resolving a managed database's URI). The
 * desktop keeps using `driver`.
 */
export const serverDriver = {
  id: driver.id,
  dialTargets(connectionString: string): DialTarget[] {
    assertSafeForServer(connectionString);
    return dialTargets(connectionString);
  },
  async query(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    assertSafeForServer(connectionString);
    return driver.query(connectionString, sql, options);
  },
  async queryReadOnly(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]> {
    assertSafeForServer(connectionString);
    return driver.queryReadOnly(connectionString, sql, options);
  },
  async execute(
    connectionString: string,
    sql: string,
    params: unknown[],
    options?: SqlNodeDriverOptions,
  ): Promise<number> {
    assertSafeForServer(connectionString);
    return driver.execute(connectionString, sql, params, options);
  },
} satisfies SqlNodeDriver;

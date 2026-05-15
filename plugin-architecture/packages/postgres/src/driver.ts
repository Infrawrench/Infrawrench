import { Pool } from "pg";
import type { SqlNodeDriver } from "@infrawrench/plugin-base";

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

function sanitizePgUrl(cs: string): string {
  try {
    const u = new URL(cs);
    u.searchParams.delete("channel_binding");
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
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: sanitizePgUrl(connectionString),
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
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
    // Bound cleanup too — pool.end() can stall when the underlying socket
    // is in a half-broken state. 2s is plenty for the local TCP teardown.
    await Promise.race([
      pool.end().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

export const driver = {
  id: "postgres",

  async query(connectionString: string, sql: string): Promise<Record<string, unknown>[]> {
    return runWithTimeout(connectionString, async (pool) => {
      return (await pool.query(sql)).rows as Record<string, unknown>[];
    });
  },

  async execute(connectionString: string, sql: string, params: unknown[]): Promise<number> {
    return runWithTimeout(connectionString, async (pool) => {
      return (await pool.query(sql, params)).rowCount ?? 0;
    });
  },
} satisfies SqlNodeDriver;

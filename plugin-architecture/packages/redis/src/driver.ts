import Redis from "ioredis";
import type { KvNodeDriver } from "@infrawrench/plugin-base";

const CONNECT_TIMEOUT_MS = 5000;

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Connection is closed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("socket hang up") ||
    msg.includes("Stream isn't writeable")
  );
}

function describeFailure(err: unknown, connectionString: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  let host = "";
  try {
    const u = new URL(connectionString);
    host = `${u.hostname}:${u.port || 6379}`;
  } catch {
    /* ignore */
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("connect ETIMEDOUT")) {
    return new Error(
      `Timed out connecting to Redis${host ? ` at ${host}` : ""}. If the host is on a private network (e.g. GCP Memorystore, AWS ElastiCache), configure an SSH tunnel for this account.`,
    );
  }
  if (msg.includes("ECONNREFUSED")) {
    return new Error(
      `Connection refused by Redis${host ? ` at ${host}` : ""}. Verify the host is reachable and the port is correct.`,
    );
  }
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return new Error(
      `Cannot resolve Redis host${host ? ` (${host})` : ""}. Check the connection string.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function runOnce(
  connectionString: string,
  cmd: string,
  args: (string | number)[],
): Promise<unknown> {
  const client = new Redis(connectionString, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableReadyCheck: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: () => null,
  });
  // ioredis emits "error" events asynchronously; without a listener an
  // ETIMEDOUT/ECONNRESET becomes an unhandled error that crashes the host
  // process. The awaited calls below surface the same error for the caller.
  client.on("error", () => {});
  try {
    await client.connect();
    const fn = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      cmd.toLowerCase()
    ];
    if (typeof fn !== "function") throw new Error(`Unknown Redis command: ${cmd}`);
    return await fn.call(client, ...args);
  } finally {
    client.disconnect();
  }
}

export const driver = {
  id: "redis",

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    try {
      return await runOnce(connectionString, cmd, args);
    } catch (err) {
      if (!isTransientError(err)) throw describeFailure(err, connectionString);
      try {
        return await runOnce(connectionString, cmd, args);
      } catch (retryErr) {
        throw describeFailure(retryErr, connectionString);
      }
    }
  },
} satisfies KvNodeDriver;

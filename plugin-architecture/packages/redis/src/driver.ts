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

/**
 * An ioredis command method reached by dynamic lookup. Every ioredis command
 * returns a promise of a reply whose shape depends on the command, so
 * `unknown` is the honest return type — the KV console renders whatever comes
 * back.
 */
type RedisCommandMethod = (this: Redis, ...args: unknown[]) => Promise<unknown>;

function isRedisCommandMethod(value: unknown): value is RedisCommandMethod {
  return typeof value === "function";
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
    const rawParts = cmd.trim().split(/\s+/).filter(Boolean);
    const commandName = rawParts[0] ?? "";
    const commandArgs = [...rawParts.slice(1), ...args];
    if (!commandName) throw new Error("Redis command is required");

    // The command name comes from the user's console input, so the method has
    // to be looked up dynamically — ioredis' `RedisCommander` interface types
    // every command individually and cannot be indexed by a runtime string.
    // Reading through `Record<string, unknown>` (rather than asserting every
    // property is a callable) keeps the `typeof === "function"` guards
    // load-bearing instead of decorative.
    const methods = client as unknown as Record<string, unknown>;
    const fn = methods[commandName.toLowerCase()];
    if (!isRedisCommandMethod(fn)) {
      const call = methods["call"];
      if (!isRedisCommandMethod(call)) throw new Error(`Unknown Redis command: ${cmd}`);
      return await call.call(client, commandName, ...commandArgs);
    }
    return await fn.call(client, ...commandArgs);
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

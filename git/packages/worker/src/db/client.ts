/**
 * The database, for a Worker.
 *
 * A Worker cannot keep a socket between requests, so every invocation (a
 * fetch, a queue batch, an SSH connection, a Durable Object alarm) opens its
 * own postgres.js client against Hyperdrive and closes it when the work and
 * everything it handed to `waitUntil` have settled. That is server-core's
 * `withEdgeInvocation`, which calls `createDb` and runs the work inside a
 * request scope; inside it, the `db` server-core exports resolves to this
 * invocation's handle. So the query modules beside this file import `db` and
 * simply use it, exactly as server-core's own modules do, and server-core
 * functions called from here (`resolveEffectivePermissions`) share the same
 * connection.
 *
 * Nothing here holds state across requests (KNOWLEDGE.md "Edge/gateway
 * split").
 */
import { withEdgeInvocation } from "@infrawrench/server-core/runtime/edge-invocation";
import type { Env } from "../env";

export { db } from "@infrawrench/server-core/db/client";
export type { Db } from "@infrawrench/server-core/db/client";
export { keepAlive } from "@infrawrench/server-core/runtime/request-scope";

/** The part of an `ExecutionContext` or a `DurableObjectState` this needs. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Run `fn` with a database client of its own. Every entry point wraps its
 * work in this once; calling a query module outside it throws, since there is
 * no process-wide pool on a Worker to fall back to.
 *
 * Two connections by default: a Worker has six outbound connections per
 * invocation, shared with R2, the Durable Object and WorkOS.
 */
export const withDb = <T>(
  env: Pick<Env, "HYPERDRIVE">,
  ctx: WaitUntil,
  fn: () => Promise<T>,
  options: { readonly maxConnections?: number } = {},
): Promise<T> => withEdgeInvocation(env, ctx, fn, { maxConnections: options.maxConnections ?? 2 });

/** Postgres's unique-violation code, through whatever wrapped the error on the way up. */
export const isUniqueViolation = (error: unknown): boolean => {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
};

/** A new row id: a UUID, like every other id in the schema. */
export const newId = (): string => crypto.randomUUID();

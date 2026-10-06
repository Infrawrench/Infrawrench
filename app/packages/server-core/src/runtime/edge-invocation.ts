/**
 * The one wrapper every edge entry point (the web Worker's fetch, the poller
 * Worker's queue consumer and scheduler alarm) runs its work inside.
 *
 * It does what a Node process does once at boot, per invocation: marks the
 * runtime as edge, points ClickHouse at the private VPC binding, and opens a
 * database client against Hyperdrive. It also owns that client's lifetime,
 * which is the subtle part: work handed to `keepAlive` (audit writes, drift
 * notifications) may still be running after `fn` returns, and closing the
 * client under it would fail those writes. So the close waits for every
 * kept-alive promise, including ones registered while it was waiting.
 */
import { createDb } from "../db/client";
import { configureClickHouseTransport } from "../clickhouse/client";
import { markEdgeRuntime } from "./gateway-only";
import { runInRequestScope } from "./request-scope";

/** The bindings an edge Worker must declare for server-core to work. */
export interface EdgeBindings {
  /** Hyperdrive in front of the primary Postgres. */
  HYPERDRIVE: { connectionString: string };
  /**
   * Workers VPC service reaching the in-cluster ClickHouse through Cloudflare
   * Tunnel. Optional: without it ClickHouse is reached at
   * `CLICKHOUSE_METRICS_URL` directly (local development, or a public
   * ClickHouse).
   */
  CLICKHOUSE?: { fetch: typeof fetch };
}

/** The part of an `ExecutionContext` / `DurableObjectState` this needs. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

let initialised = false;

function initEdgeRuntime(env: EdgeBindings): void {
  if (initialised) return;
  markEdgeRuntime();
  const clickhouse = env.CLICKHOUSE;
  if (clickhouse) {
    configureClickHouseTransport((input, init) => clickhouse.fetch(input, init));
  }
  initialised = true;
}

export interface EdgeInvocationOptions {
  /**
   * Postgres connections this invocation may open. Workers cap simultaneous
   * outbound connections at six per invocation, shared with every fetch the
   * work makes, so keep it small.
   */
  maxConnections?: number;
}

export async function withEdgeInvocation<T>(
  env: EdgeBindings,
  ctx: WaitUntilContext,
  fn: () => Promise<T>,
  options: EdgeInvocationOptions = {},
): Promise<T> {
  initEdgeRuntime(env);
  const { db, close } = createDb(env.HYPERDRIVE.connectionString, {
    max: options.maxConnections ?? 3,
    // Hyperdrive caches prepared statements; the type round-trip only matters
    // for array-typed columns, which postgres.js parses fine without it.
    fetch_types: false,
  });
  const pending: Promise<unknown>[] = [];
  const scope = {
    db,
    // Root tracker: `gatewayOnlyHitInScope()` reads it after the work.
    gatewayOnly: {},
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      ctx.waitUntil(promise);
    },
  };
  try {
    return await runInRequestScope(scope, fn);
  } finally {
    ctx.waitUntil(
      (async () => {
        let settled = 0;
        while (settled < pending.length) {
          const batch = pending.slice(settled);
          settled = pending.length;
          await Promise.allSettled(batch);
        }
        await close();
      })(),
    );
  }
}

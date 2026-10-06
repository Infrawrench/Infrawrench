/**
 * Per-invocation state for code that runs on both Node and the edge.
 *
 * On Node a process holds one database pool for its lifetime. A Worker cannot:
 * a socket opened while handling one request cannot be touched while handling
 * another ("Cannot perform I/O on behalf of a different request"), so each
 * edge invocation opens its own client (cheap: Hyperdrive holds the real pool)
 * and closes it when the invocation ends. The same invocation also owns the
 * `waitUntil` that keeps fire-and-forget work alive after the response is
 * sent, which Node gets for free.
 *
 * Both live here, in one AsyncLocalStorage, so the hundreds of modules that
 * `import { db }` keep doing exactly that: `db` resolves through this scope
 * when one is active and falls back to the process-wide pool otherwise.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  /** The invocation's own Drizzle handle (edge only; Node uses the shared pool). */
  db?: unknown;
  /** Extends the invocation until the promise settles (`ExecutionContext.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Where gateway-only hits inside this scope are recorded (edge only). */
  gatewayOnly?: GatewayOnlyTracker;
  /**
   * Database writes started in this scope (edge only), counted by the `db`
   * proxy. The edge replays a request on the gateway only if it has written
   * nothing, since a replay would otherwise do the writes twice.
   */
  dbWrites?: { count: number };
}

/**
 * Records that work in a scope reached a gateway-only code path, *even if the
 * code that reached it caught the error*. Plugins routinely do: the Postgres
 * plugin answers a failed catalog query with a placeholder database built
 * from the connection string, which on the edge would silently replace the
 * real list. Trackers nest (one per resource type in a sync, under one per
 * request) and a hit marks every ancestor.
 */
interface GatewayOnlyTracker {
  hit?: string;
  parent?: GatewayOnlyTracker | undefined;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore();
}

/**
 * Mark a promise the caller deliberately does not await (an audit write, a
 * drift notification) as work the invocation must finish. A no-op on Node,
 * where the process outlives the request anyway; on the edge it is the
 * difference between the write landing and the isolate being torn down
 * mid-flight. Rejections are swallowed here only for the keep-alive copy;
 * the returned promise is the caller's, unchanged.
 */
export function keepAlive<T>(promise: Promise<T>): Promise<T> {
  storage.getStore()?.waitUntil?.(promise.catch(() => {}));
  return promise;
}

/** Mark the current scope (and every enclosing one) as having hit a gateway-only path. */
export function noteGatewayOnlyHit(what: string): void {
  for (let t = storage.getStore()?.gatewayOnly; t; t = t.parent) t.hit ??= what;
}

/** What the current scope hit, if anything. */
export function gatewayOnlyHitInScope(): string | undefined {
  return storage.getStore()?.gatewayOnly?.hit;
}

/**
 * Run `fn` under its own gateway-only tracker and report what it hit. The
 * outcome is returned rather than thrown so the caller decides what a hit
 * means; a rejection is passed through with the hit attached.
 */
export async function trackGatewayOnlyHits<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; hit?: string } | { ok: false; error: unknown; hit?: string }> {
  const parent = storage.getStore();
  const tracker: GatewayOnlyTracker = { parent: parent?.gatewayOnly };
  try {
    const value = await storage.run({ ...parent, gatewayOnly: tracker }, fn);
    return tracker.hit ? { ok: true, value, hit: tracker.hit } : { ok: true, value };
  } catch (error) {
    return tracker.hit ? { ok: false, error, hit: tracker.hit } : { ok: false, error };
  }
}

/** Count a database write against the current scope (called by the `db` proxy). */
export function noteDbWrite(): void {
  const writes = storage.getStore()?.dbWrites;
  if (writes) writes.count++;
}

/** Database writes the current scope has started so far. */
export function dbWritesInScope(): number {
  return storage.getStore()?.dbWrites?.count ?? 0;
}

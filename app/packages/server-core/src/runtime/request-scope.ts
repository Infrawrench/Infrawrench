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
  /**
   * Set by the web Lambda (`web/lambda/handler.ts`), which is a real Node
   * process but not a long-lived one: process-local state such as bastion
   * agent connections never lives there. Reaching it inside this scope is
   * recorded as a gateway-only hit, so the request is handed on to the
   * session gateway, which holds that state, instead of failing. The Lambda
   * poller leaves it unset and behaves exactly like the Node poller.
   */
  sessionHandoff?: boolean;
  /** Secret writes a create holds until its resource's row exists; see `holdSecretWrites`. */
  heldSecretWrites?: HeldSecretWrites;
  /** Where a list a plugin refused to complete inside this scope is recorded. */
  incompleteList?: IncompleteListTracker;
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

/**
 * Records that a plugin's list read could not say it had every row, *even if the
 * plugin caught the error*, as `.catch(() => [])` around a child list does. That
 * reads as an empty list, and the sync prunes what it stops seeing.
 */
interface IncompleteListTracker {
  error?: Error;
  parent?: IncompleteListTracker | undefined;
}

/** Writes `setPlaintext` was asked for during a create, by resource and field. */
export type HeldSecretWrites = Map<string, { value: string; write: () => Promise<void> }>;

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

function noteIncompleteList(error: Error): void {
  for (let t = storage.getStore()?.incompleteList; t; t = t.parent) t.error ??= error;
}

// `IncompleteListError` calls this. A global because plugins are bundled with their
// own copy of plugin-base, the same reason `GatewayOnlyError`'s stub reaches a hook.
Reflect.set(globalThis, Symbol.for("infrawrench.incompleteList"), noteIncompleteList);

/**
 * Run a read whose result gets pruned or reconciled against, and fail if a list
 * inside it was refused, whether or not the plugin caught that. A list read twice by
 * a plugin's cache only marks the scope that started it.
 */
export async function runListChecked<T>(fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const tracker: IncompleteListTracker = { parent: parent?.incompleteList };
  const value = await storage.run({ ...parent, incompleteList: tracker }, fn);
  if (tracker.error) throw tracker.error;
  return value;
}

/** Run `fn` with the secret writes it asks for going into `held`, not the database. */
export function runHoldingSecretWrites<T>(
  held: HeldSecretWrites,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...storage.getStore(), heldSecretWrites: held }, fn);
}

/** Where a secret write goes instead of the database, while a create holds them. */
export function heldSecretWritesInScope(): HeldSecretWrites | undefined {
  return storage.getStore()?.heldSecretWrites;
}

/** Whether this scope hands work that needs process-local state to the session gateway. */
export function sessionHandoffInScope(): boolean {
  return storage.getStore()?.sessionHandoff === true;
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

/**
 * Calling promise-returning code from an Effect handler without losing the
 * request's AsyncLocalStorage scopes.
 *
 * Much of the server reads per-request state from AsyncLocalStorage rather
 * than from its arguments: the caller's cost visibility (every ClickHouse cost
 * reader), its object-sharing principal, the API key an audit row is
 * attributed to, and the edge invocation's request scope (`keepAlive`, the
 * per-invocation Postgres client, gateway-only tracking, held secret writes).
 *
 * Effect does not carry AsyncLocalStorage. Its scheduler drains one shared
 * task queue, so after any yield a fiber can resume inside a callback another
 * request's fiber scheduled, under *that* request's store. Code reading a store
 * from inside an Effect could therefore see a different tenant's cost scope.
 *
 * The rule that keeps this safe:
 *
 * - Effect code never reads AsyncLocalStorage. The auth middleware captures
 *   each scope into {@link LegacyScopes} on the fiber's own context.
 * - Every call into promise code goes through {@link legacy} (or
 *   {@link legacyTry}), which re-enters all of the scopes explicitly and
 *   invokes the function synchronously inside them, so every continuation the
 *   promise code creates captures the right store, whatever the scheduler did.
 */
import { Context, Effect, type Exit } from "effect";
import {
  currentRequestScope,
  runInRequestScope,
  type RequestScope,
} from "@infrawrench/server-core/runtime/request-scope";
import {
  currentCostVisibility,
  runWithCostVisibility,
  type CostVisibility,
} from "@infrawrench/server-core/cost/visibility-context";
import {
  currentSharingPrincipal,
  runWithSharingPrincipal,
  type SharingPrincipal,
} from "../services/sharing-context";
import {
  currentAuditPrincipal,
  runWithAuditPrincipal,
  type AuditPrincipal,
} from "../services/audit-context";

export interface LegacyScopeValues {
  readonly requestScope: RequestScope | undefined;
  readonly costVisibility: CostVisibility | undefined;
  readonly sharing: SharingPrincipal | undefined;
  readonly auditPrincipal: AuditPrincipal | undefined;
}

const EMPTY_SCOPES: LegacyScopeValues = {
  requestScope: undefined,
  costVisibility: undefined,
  sharing: undefined,
  auditPrincipal: undefined,
};

/**
 * The AsyncLocalStorage values this request runs under, captured once and
 * carried on the fiber. Empty by default: a fiber that never passed through the
 * HTTP entry or an auth middleware runs promise code with no scope at all,
 * which is what the same code saw outside a request before.
 */
export const LegacyScopes = Context.Reference<LegacyScopeValues>("infrawrench/http/LegacyScopes", {
  defaultValue: () => EMPTY_SCOPES,
});

/** Run `fn` synchronously inside every scope in `scopes`. */
export function runInLegacyScopes<T>(scopes: LegacyScopeValues, fn: () => T): T {
  let run = fn;
  if (scopes.auditPrincipal) {
    const principal = scopes.auditPrincipal;
    const inner = run;
    run = () => runWithAuditPrincipal(principal, inner);
  }
  if (scopes.sharing) {
    const sharing = scopes.sharing;
    const inner = run;
    run = () => runWithSharingPrincipal(sharing, inner);
  }
  if (scopes.costVisibility) {
    const visibility = scopes.costVisibility;
    const inner = run;
    run = () => runWithCostVisibility(visibility, inner);
  }
  if (scopes.requestScope) {
    const requestScope = scopes.requestScope;
    const inner = run;
    run = () => runInRequestScope(requestScope, inner);
  }
  return run();
}

/** Narrow the fiber's scopes for the rest of `effect`, e.g. after auth resolves a principal. */
export const withLegacyScopes =
  (patch: Partial<LegacyScopeValues>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const current = yield* LegacyScopes;
      return yield* Effect.provideService(effect, LegacyScopes, { ...current, ...patch });
    });

/**
 * Call promise code from Effect, inside the request's scopes. A rejection is a
 * defect: the API's error renderer turns the errors the old `onError` knew
 * (object sharing, gateway-only, `HTTPException`) into the same responses, and
 * anything else into a 500 with a correlation id.
 */
export const legacy = <A>(fn: (signal: AbortSignal) => PromiseLike<A> | A): Effect.Effect<A> =>
  Effect.gen(function* () {
    const scopes = yield* LegacyScopes;
    // `Promise.resolve` so a function that returns a plain value (a stub, a
    // synchronous service) is answered rather than rejected.
    return yield* Effect.promise((signal) =>
      Promise.resolve(runInLegacyScopes(scopes, () => fn(signal))),
    );
  });

/**
 * {@link legacy}, with some rejections turned into typed failures. `mapError`
 * returns the failure for an error it recognises and `undefined` for one it
 * does not, which stays a defect.
 */
export const legacyTry = <A, E>(
  fn: (signal: AbortSignal) => PromiseLike<A> | A,
  mapError: (error: unknown) => E | undefined,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const scopes = yield* LegacyScopes;
    return yield* Effect.tryPromise({
      try: (signal) => Promise.resolve(runInLegacyScopes(scopes, () => fn(signal))),
      // A throwing `catch` makes the rejection a defect carrying the original
      // error, which is what an unrecognised error should be.
      catch: (error) => {
        const mapped = mapError(error);
        if (mapped === undefined) throw error;
        return mapped;
      },
    });
  });

/**
 * The scopes promise code is running under right now. Read only at a promise
 * boundary, synchronously, before any Effect runs: that is the one place the
 * ambient store is known to be the caller's own.
 */
export function ambientLegacyScopes(): LegacyScopeValues {
  return {
    requestScope: currentRequestScope(),
    costVisibility: currentCostVisibility(),
    sharing: currentSharingPrincipal(),
    auditPrincipal: currentAuditPrincipal(),
  };
}

/**
 * Run an Effect from promise code (a Hono handler, a tool, a background loop)
 * carrying the caller's scopes onto the fiber, so the `legacy` calls inside it
 * re-enter them. The promise rejects with whatever the Effect failed or died with.
 */
export function runFromLegacy<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const scopes = ambientLegacyScopes();
  return Effect.runPromise(Effect.provideService(effect, LegacyScopes, scopes));
}

/** {@link runFromLegacy}, resolving to the Exit instead of rejecting. */
export function runFromLegacyExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  const scopes = ambientLegacyScopes();
  return Effect.runPromiseExit(Effect.provideService(effect, LegacyScopes, scopes));
}

/**
 * Start fire-and-forget promise work (`void logAudit(...)`) inside the
 * request's scopes, synchronously, and carry on without waiting. Started here
 * rather than on a forked fiber so it begins before the response is sent: on
 * the edge, work that wants `keepAlive` has to register while the invocation
 * is still open.
 */
export const fireAndForget = (fn: () => PromiseLike<unknown>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const scopes = yield* LegacyScopes;
    runInLegacyScopes(scopes, () => {
      void Promise.resolve(fn()).then(undefined, (error: unknown) => {
        console.error("[api] background work failed:", error);
      });
    });
  });

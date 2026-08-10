/**
 * The credential the current request is running under, carried out-of-band so
 * `logAudit` can record it without every call site being rewritten.
 *
 * There are 120-odd `logAudit` call sites across the route tree and they all
 * pass `userId` — which stays correct for an API key, since a key acts as its
 * owner. What none of them pass is *which key*, and once keys can reach the
 * whole org tree "a write attributed to Alice" stops being enough: an operator
 * investigating has to be able to tell Alice-at-a-keyboard from the CI token
 * Alice minted last quarter, and to revoke the right one.
 *
 * Threading an extra argument through every handler would be a large diff whose
 * failure mode is silent (a missed call site logs `NULL` and looks fine), so the
 * principal rides an `AsyncLocalStorage` instead: the API-key middleware
 * establishes it for the request, and {@link logAudit} reads it when the caller
 * did not name a key explicitly. An explicit `apiKeyId` always wins, so the few
 * call sites that already pass one (sync, pages, cost ingest, the SSH tools)
 * keep behaving exactly as they do now.
 *
 * Fire-and-forget calls (`void logAudit(...)`) are unaffected: the store is
 * captured when the async operation starts, which is inside the request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuditPrincipal {
  /** `api_keys.id` of the credential the request presented. */
  apiKeyId: string;
  /** The key's owner — recorded as the actor, matching every other surface. */
  userId: string;
}

const storage = new AsyncLocalStorage<AuditPrincipal>();

/** Run `fn` with `principal` visible to {@link currentAuditPrincipal}. */
export function runWithAuditPrincipal<T>(principal: AuditPrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

/**
 * Establish `principal` for the remainder of the current async execution.
 *
 * Used by `auth/org-request-auth.ts`, which authenticates and *returns* rather
 * than wrapping a continuation, so it has no callback to hand
 * {@link runWithAuditPrincipal}. Prefer that function wherever a continuation
 * exists; this one mutates the ambient store and is only correct because a Hono
 * request handler owns its async context for the rest of the request.
 */
export function enterAuditPrincipal(principal: AuditPrincipal): void {
  storage.enterWith(principal);
}

/** The API-key principal for the current request, if it authenticated as one. */
export function currentAuditPrincipal(): AuditPrincipal | undefined {
  return storage.getStore();
}

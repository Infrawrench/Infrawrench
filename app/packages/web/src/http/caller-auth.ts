/**
 * Authentication for endpoints that authenticate themselves rather than
 * through the org tree's chain (`OrgAuth`): the bearer-only `/api/v1/*`
 * surface (whoami, desktop sync, the pricing data) and the push routes an
 * unattended server calls with an `iwk_` key (cost rows, pages).
 *
 * Handler-level, not a middleware, on purpose. Each of these routes always
 * ran its authenticator as its own first statement, in its own words, and the
 * order matters: who is asking is settled before the body is read, but a
 * route's other refusals come between (the instance pricing query accepts the
 * apps' published key before any credential is consulted; desktop sync checks
 * the key's scope after authenticating). So an endpoint here is served with
 * `handleRaw` (its params and query documented with `documentedAs`, so
 * nothing is decoded and refused ahead of the handler), and the handler's
 * first step is one of:
 *
 * - `asBearerCaller` (`./bearer-caller.ts`): `authenticateApiRequest` (an `iwk_` key, an agent
 *   credential, or a WorkOS access token for a person or an agent), with the
 *   `401 { error: "Unauthorized" }` every `/api/v1` route has sent.
 * - `asOrgRequestCaller` (`./org-request-caller.ts`): `authenticateOrgRawRequest` against the
 *   path's `:orgId` and a required scope, with its own 401/403/500 sentences
 *   (`Missing required scope: ...`, `API key belongs to a different
 *   organization`, ...). The endpoint documents that scope with
 *   `DocumentedPermission`, since `OrgAuth` does not enforce it.
 *
 * Both run the existing promise authenticator through `legacy`, answer its
 * refusal exactly as the Hono route did (an `HttpFailure`, rendered as its
 * status and body), and run the rest of the handler with the key as the
 * request's audit principal, carried on the fiber through
 * `withLegacyScopes({ auditPrincipal })`: Effect code never calls
 * `enterAuditPrincipal`.
 *
 * Route tests mock the authenticators at their modules (`@/auth/api-auth`,
 * `@/auth/org-request-auth`), exactly as they did for the Hono routes; each
 * authenticator has its own module here so a test loads only the one its
 * domain uses. A new kind of self-authenticating caller is an `authenticate`
 * effect handed to {@link asCaller}.
 */
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import type { AuditPrincipal } from "../services/audit-context";
import { HttpFailure } from "./errors";
import { withLegacyScopes } from "./legacy";
import { failureResponse } from "./middleware";

/** The web `Request` behind the current HttpApi request. */
export const rawRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const source = request.source;
  if (source instanceof Request) return source;
  return yield* Effect.die(new Error("HttpApi request has no web Request source"));
});

const isHttpFailure = <E>(error: E): error is Extract<E, HttpFailure> =>
  error instanceof HttpFailure;

/** What every self-authenticating caller carries: who it acts as, and the key, if one. */
export interface CallerIdentity {
  readonly userId: string;
  readonly apiKeyId?: string | undefined;
}

/**
 * Run `authenticate`, then `serve` as the caller it resolved, with the key it
 * presented (if any) as the request's audit principal. A refusal from either
 * (an {@link HttpFailure}) is sent as its status and body, which is how the
 * Hono routes returned their authenticator's `Response`.
 */
export const asCaller = <C extends CallerIdentity, E1, R1, A, E, R>(
  authenticate: Effect.Effect<C, E1, R1>,
  serve: (caller: C) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(authenticate, (caller) => {
    if (caller.apiKeyId === undefined) return serve(caller);
    const auditPrincipal: AuditPrincipal = { apiKeyId: caller.apiKeyId, userId: caller.userId };
    return withLegacyScopes({ auditPrincipal })(serve(caller));
  }).pipe(Effect.catchIf(isHttpFailure, (failure) => Effect.succeed(failureResponse(failure))));

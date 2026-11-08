/**
 * The HttpApi middlewares every Infrawrench group is served through.
 *
 * - {@link OrgAuth}: the org tree (`/api/org/:orgId/...`). Authenticates,
 *   resolves cost visibility and the sharing principal, gates on the
 *   endpoint's {@link RequiredPermission}, and provides {@link OrgPrincipal}
 *   plus the request's AsyncLocalStorage scopes.
 * - {@link SessionAuth}: the user-scoped surface. A person only.
 * - {@link RequestErrors}: on every group, outermost. Renders schema failures
 *   as `{ error, issues }` 400s and defects as the API always has.
 *
 * This module holds the middleware tags, the gate shared with tests and the
 * error renderer, and stays light: domain modules import it. The auth-backed
 * implementations live in `./middleware-live.ts`.
 *
 * Refusals from the auth chain are returned as responses rather than declared
 * as endpoint errors, so the generated document lists the statuses each
 * operation chooses to, as the hand-written one did.
 */
import { randomUUID } from "node:crypto";
import { Cause, Context, Effect, Layer, Predicate, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiError, type HttpApiEndpoint } from "effect/http-api";
import {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  GatewayTimeout,
  Gone,
  InternalServerError,
  InvalidRequestMessage,
  NotFound,
  PaymentRequired,
  RequestErrors,
  RequiredPermission,
  ServiceUnavailable,
  Unauthorized,
  UnprocessableEntity,
} from "@infrawrench/api-contract";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  GATEWAY_ONLY_HEADER,
  isGatewayOnlyError,
} from "@infrawrench/server-core/runtime/gateway-only";
import type { AuditPrincipal } from "../services/audit-context";
import {
  ObjectAccessDeniedError,
  ObjectNotVisibleError,
  SharingInputError,
  type SharingPrincipal,
} from "../services/sharing-context";
import { HttpFailure } from "./errors";
import { withLegacyScopes } from "./legacy";
import { missingPermission, OrgPrincipal, type OrgPrincipalValue } from "./principal";

export { OrgAuth, RequestErrors, SessionAuth } from "@infrawrench/api-contract";

export const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status });

export const failureResponse = (failure: HttpFailure) => json(failure.body, failure.status);

/**
 * The org tree once the caller is known: gate on the endpoint's
 * {@link RequiredPermission}, then run it with {@link OrgPrincipal} and the
 * caller's AsyncLocalStorage scopes. Shared by `OrgAuthLive` and the route
 * tests' fixed caller, so a test's 403 is the real gate's.
 */
export const serveAsOrgCaller = <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  endpoint: HttpApiEndpoint.Top,
  caller: {
    readonly principal: OrgPrincipalValue;
    readonly sharing: SharingPrincipal | undefined;
    readonly auditPrincipal: AuditPrincipal | undefined;
  },
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Exclude<R, OrgPrincipal>> => {
  const required = Context.get(endpoint.annotations, RequiredPermission);
  if (required !== undefined && !hasPermission(caller.principal.permissions, required)) {
    return Effect.succeed(json({ error: missingPermission(required).error }, 403));
  }
  return httpEffect.pipe(
    Effect.provideService(OrgPrincipal, caller.principal),
    withLegacyScopes({
      costVisibility: caller.principal.costVisibility,
      sharing: caller.sharing,
      auditPrincipal: caller.auditPrincipal,
    }),
  );
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const API_ERRORS = [
  [BadRequest, 400],
  [Unauthorized, 401],
  [PaymentRequired, 402],
  [Forbidden, 403],
  [NotFound, 404],
  [Conflict, 409],
  [Gone, 410],
  [UnprocessableEntity, 422],
  [InternalServerError, 500],
  [BadGateway, 502],
  [ServiceUnavailable, 503],
  [GatewayTimeout, 504],
] as const;

/** The status of one of `./errors.ts`'s classes, or undefined for anything else. */
function apiErrorStatus(error: unknown): number | undefined {
  for (const [errorClass, status] of API_ERRORS) {
    if (error instanceof errorClass) return status;
  }
  return undefined;
}

/**
 * A defect as the API has always answered it. Object sharing throws from the
 * services the routes and tools share: an object below `viewer` is a 404 so
 * its existence does not leak, one the caller can see but not change a 403.
 */
export function renderDefect(defect: unknown): HttpServerResponse.HttpServerResponse {
  if (defect instanceof HttpFailure) return failureResponse(defect);
  const apiStatus = apiErrorStatus(defect);
  if (apiStatus !== undefined && Predicate.hasProperty(defect, "error")) {
    return json({ error: defect.error }, apiStatus);
  }
  if (defect instanceof ObjectNotVisibleError) return json({ error: "Not found" }, 404);
  if (defect instanceof ObjectAccessDeniedError) return json({ error: defect.message }, 403);
  if (defect instanceof SharingInputError) return json({ error: defect.message }, 400);
  // Only on the edge, where Node-only libraries are stubs: the edge router
  // sees the header and replays the request on the Node gateway.
  if (isGatewayOnlyError(defect)) {
    return HttpServerResponse.setHeader(
      json({ error: "This request could not be completed here. Please try again." }, 503),
      GATEWAY_ONLY_HEADER,
      "1",
    );
  }
  // In production the message and stack stay in the log: they leak schema, paths, secrets.
  const correlationId = randomUUID();
  console.error(`[api] uncaught error correlationId=${correlationId}:`, defect);
  if (process.env["NODE_ENV"] === "production") {
    return json({ error: "Internal server error", correlationId }, 500);
  }
  const message = defect instanceof Error ? defect.message : String(defect);
  return json({ error: message, correlationId }, 500);
}

export const RequestErrorsLive = Layer.succeed(RequestErrors)((httpEffect, { endpoint }) => {
  // A request whose params, query, headers or payload fail their schema: the
  // 400 every route has sent, `{ error, issues }`. Decoding runs inside the
  // middleware stack, so it reaches here as a typed failure; a schema error
  // raised later (the response body or headers) is a server bug and a 500.
  const schemaErrorResponse = (error: HttpApiError.HttpApiSchemaError) =>
    error.kind === "Body" || error.kind === "ResponseHeaders"
      ? renderDefect(error)
      : json(
          {
            error: Context.get(endpoint.annotations, InvalidRequestMessage),
            ...formatIssues(error.cause.issue),
          },
          400,
        );
  return httpEffect.pipe(
    Effect.catchCause((cause) => {
      const failed = Cause.findError(cause);
      if (failed._tag === "Success") {
        const error: unknown = failed.success;
        if (HttpApiError.HttpApiSchemaError.is(error)) {
          return Effect.succeed(schemaErrorResponse(error));
        }
        // The API's own error classes render themselves, declared or not: an
        // endpoint that forgot to declare `Forbidden` beside a handler-level
        // `requirePermission` would otherwise fail to encode it and answer 500.
        const status = apiErrorStatus(error);
        if (status !== undefined && Predicate.hasProperty(error, "error")) {
          return Effect.succeed(json({ error: error.error }, status));
        }
        // Every other typed failure is the endpoint's to encode.
        return Effect.failCause(cause);
      }
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const found = Cause.findDefect(cause);
      const defect = found._tag === "Success" ? found.success : Cause.squash(cause);
      if (HttpApiError.HttpApiSchemaError.is(defect)) {
        return Effect.succeed(schemaErrorResponse(defect));
      }
      return Effect.succeed(renderDefect(defect));
    }),
  );
});

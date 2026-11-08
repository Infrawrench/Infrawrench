/**
 * The auth-backed middleware implementations: what the server provides for
 * {@link OrgAuth} and {@link SessionAuth}. Imported by the server entry only,
 * never by a domain, so a route test that runs a domain as a fixed caller
 * (`./testing.ts`) loads none of the auth chain, the database, or the cost
 * visibility resolver.
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { COST_SCOPE_RESTRICTED_CODE } from "@infrawrench/client-core";
import { resolveCostVisibility } from "@infrawrench/server-core/cost/visibility";
import { costScopeRouteDenial } from "../auth/cost-visibility";
import { resolveSharingPrincipal } from "../services/object-sharing";
import { authenticateOrgCaller, authenticatePerson } from "./auth";
import { legacy } from "./legacy";
import {
  failureResponse,
  json,
  OrgAuth,
  RequestErrorsLive,
  serveAsOrgCaller,
  SessionAuth,
} from "./middleware";
import { costVisibilityPrincipal, SessionPrincipal } from "./principal";
import { keepRefreshedSession } from "./session-cookie";

/** The raw web `Request` behind the current HttpApi request. */
const rawRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const source = request.source;
  if (source instanceof Request) return source;
  return yield* Effect.die(new Error("HttpApi request has no web Request source"));
});

const routeParam = Effect.fnUntraced(function* (name: string) {
  const route = yield* HttpRouter.RouteContext;
  return route.params[name];
});

export const OrgAuthLive = Layer.succeed(OrgAuth)((httpEffect, { endpoint }) =>
  Effect.gen(function* () {
    const raw = yield* rawRequest;
    const orgId = yield* routeParam("orgId");
    const authenticated = yield* Effect.result(authenticateOrgCaller({ raw, orgId }));
    if (authenticated._tag === "Failure") return failureResponse(authenticated.failure);
    const caller = authenticated.success;
    // Before anything below can refuse: every response carries a refreshed session.
    yield* keepRefreshedSession(caller.refreshedSession);

    // Fails closed: a resolution error is a 500, never an unscoped request.
    const costVisibility = yield* legacy(() =>
      resolveCostVisibility(caller.organizationId, costVisibilityPrincipal(caller)),
    );
    if (costVisibility.restricted) {
      const denial = costScopeRouteDenial(raw.method, new URL(raw.url).pathname);
      if (denial) return json({ error: denial, code: COST_SCOPE_RESTRICTED_CODE }, 403);
    }
    const sharing = yield* legacy(() =>
      resolveSharingPrincipal(caller.organizationId, caller.session.userId, caller.permissions),
    );

    return yield* serveAsOrgCaller(httpEffect, endpoint, {
      principal: {
        session: caller.session,
        organizationId: caller.organizationId,
        permissions: caller.permissions,
        role: caller.role,
        elevations: caller.elevations,
        apiKey: caller.apiKey,
        costVisibility,
      },
      sharing,
      auditPrincipal: caller.auditPrincipal,
    });
  }),
);

export const SessionAuthLive = Layer.succeed(SessionAuth)((httpEffect) =>
  Effect.gen(function* () {
    const raw = yield* rawRequest;
    const authenticated = yield* Effect.result(authenticatePerson({ raw, orgId: undefined }));
    if (authenticated._tag === "Failure") return failureResponse(authenticated.failure);
    const person = authenticated.success;
    yield* keepRefreshedSession(person.refreshedSession);
    return yield* Effect.provideService(httpEffect, SessionPrincipal, person.session);
  }),
);

/** Every middleware implementation, for the server to provide once. */
export const MiddlewareLive = Layer.mergeAll(OrgAuthLive, SessionAuthLive, RequestErrorsLive);

/**
 * Guarding the rest of a prefix whole.
 *
 * Some surfaces have always authenticated every request under their prefix,
 * routed or not: an unknown path or method there answers 401 to a caller
 * without a credential, and the 404 only to one with a credential. (They were
 * Hono sub-apps with `app.use("*", auth)` once, and their callers learned to
 * rely on it.) HttpApi middleware only wraps the endpoints it is declared on,
 * so a domain owning such a prefix guards the rest of it with
 * {@link guardPrefixes}: every method on `prefix` and `prefix/*` that no
 * endpoint routes (FindMyWay prefers the endpoints' static and parametric
 * segments to the wildcard) runs `guard`, which either answers (the 401) or
 * lets the request through to the same `404 Not Found` as any unknown path.
 * {@link guardSessionPrefixes} does it for the session-only prefixes, and
 * {@link orgTreeGuard} for the org tree, `/api/org/:orgId`.
 */
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, type HttpServerRequest, type HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import type { AuthSession } from "../auth/users";
import type { Domain } from "./domain";
import { renderDefect } from "./middleware";
import { OrgAuth, SessionAuth } from "./middleware-tags";
import { SessionPrincipal } from "./principal";
import { notFound } from "./server";

/**
 * Answers a request under the prefix that no endpoint routes, or returns
 * `undefined` to let it through to the 404. A defect renders as the API's
 * errors do.
 */
export type PrefixGuard = Effect.Effect<
  HttpServerResponse.HttpServerResponse | undefined,
  never,
  HttpServerRequest.HttpServerRequest
>;

/** A method the router takes a route for: `"*"` or one HTTP method. */
type RouteMethod = Parameters<typeof HttpRouter.add>[0];

/**
 * `domain`, also running `guard` for everything else under each of `prefixes`
 * (the prefix itself included). `methods` narrows it to the methods the
 * endpoints leave free: FindMyWay refuses a second handler for a method and
 * path an endpoint already has, and a wildcard route also claims its prefix.
 */
export function guardPrefixes(
  domain: Domain,
  prefixes: readonly `/${string}`[],
  guard: PrefixGuard,
  methods: readonly RouteMethod[] = ["*"],
): Domain {
  const handler = guard.pipe(
    Effect.map((response) => response ?? notFound()),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.succeed(renderDefect(Cause.squash(cause))),
    ),
  );
  // `prefix/*` registers `prefix` as well.
  const routes = prefixes.flatMap((prefix) =>
    methods.map((method) => HttpRouter.add(method, `${prefix}/*`, handler)),
  );
  return { ...domain, layer: Layer.mergeAll(domain.layer, ...routes) };
}

/**
 * What a guard hands the auth middleware as "the endpoint": an endpoint with
 * no annotations, so no permission gate applies and the middleware only
 * authenticates. The middleware contract passes one, typed as the router
 * hands it over.
 */
const guardTarget = (
  name: string,
): {
  readonly endpoint: HttpApiEndpoint.Top;
  readonly group: HttpApiGroup.Top;
} => {
  const targets: Array<{ endpoint: HttpApiEndpoint.Top; group: HttpApiGroup.Top }> = [];
  HttpApi.reflect(
    HttpApi.make(name).add(HttpApiGroup.make(name).add(HttpApiEndpoint.get(name, "/"))),
    {
      onGroup() {},
      onEndpoint: ({ endpoint, group }) => void targets.push({ endpoint, group }),
    },
  );
  const [target] = targets;
  if (!target) throw new Error(`the ${name} endpoint did not reflect`);
  return target;
};

/** A middleware's refusal or defect, rendered as the API's errors are. */
const renderingDefects = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.orDie,
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.succeed(renderDefect(Cause.squash(cause))),
    ),
  );

/** The methods the guard takes on a bare prefix an endpoint does not already route. */
const BARE_PREFIX_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * {@link guardPrefixes} for a session-only prefix (`/api/profile`): every
 * request under it that no endpoint routes runs {@link SessionAuth}, the
 * middleware the endpoints run, so a caller without a person's session gets
 * the 401 or 403 it always did from whichever implementation the server (or a
 * test) provides. `check` refuses an authenticated caller the prefix has
 * always refused before its 404 (the platform-admin allowlist); anything else
 * gets the 404.
 *
 * The routes are `prefix/:segment/*` (which also claims `prefix/:segment`) and
 * the bare `prefix` for each method no endpoint has there: a wildcard on the
 * prefix itself would claim the bare path for every method, which the router
 * refuses beside `GET /api/profile`. A guarded prefix must not have an endpoint
 * with a parameter as its first segment.
 */
export function guardSessionPrefixes(
  domain: Domain,
  prefixes: readonly `/${string}`[],
  check: (session: AuthSession) => HttpServerResponse.HttpServerResponse | undefined = () =>
    undefined,
): Domain {
  const endpoints = domain.endpoints();
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const sessionAuth = yield* SessionAuth;
      const handler = renderingDefects(
        sessionAuth(
          Effect.gen(function* () {
            const session = yield* SessionPrincipal;
            return check(session) ?? notFound();
          }),
          guardTarget("sessionGuard"),
        ),
      );
      const layers = prefixes.flatMap((prefix) => {
        const routed = new Set(
          endpoints
            .filter((endpoint) => endpoint.path.replace(/\/$/, "") === prefix)
            .map((endpoint) => endpoint.method.toUpperCase()),
        );
        const bare =
          routed.size === 0
            ? [HttpRouter.add("*", prefix, handler)]
            : BARE_PREFIX_METHODS.filter((method) => !routed.has(method)).map((method) =>
                HttpRouter.add(method, prefix, handler),
              );
        return [HttpRouter.add("*", `${prefix}/:segment/*`, handler), ...bare];
      });
      return Layer.mergeAll(Layer.empty, ...layers);
    }),
  );
  return { ...domain, layer: Layer.mergeAll(domain.layer, routes) };
}

/** The org tree every org-scoped endpoint sits under. */
export const ORG_TREE_PREFIX = "/api/org/:orgId";

/**
 * The org tree's answer to a path under {@link ORG_TREE_PREFIX} that no
 * endpoint routes: {@link OrgAuth}, the middleware every org-scoped endpoint
 * runs, then the 404. A caller without a credential gets the 401, one who is
 * not a member the 403, and a cost-scoped one the refusal of an org-wide
 * surface, before anyone learns whether the path exists, as the org tree has
 * always answered. Served beside the domains rather than as one: it has no
 * endpoints and documents nothing.
 *
 * The route is `prefix/*`, which also claims the bare prefix for every
 * method; no endpoint sits on the bare prefix or has a parameter as the
 * segment after it, which would compete with the wildcard.
 */
export const orgTreeGuard = (): Domain => {
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const orgAuth = yield* OrgAuth;
      const handler = renderingDefects(orgAuth(Effect.sync(notFound), guardTarget("orgTreeGuard")));
      return HttpRouter.add("*", `${ORG_TREE_PREFIX}/*`, handler);
    }),
  );
  return {
    name: "org-tree-guard",
    layer,
    openapi: () => OpenApi.fromApi(HttpApi.make("orgTreeGuard")),
    endpoints: () => [],
  };
};

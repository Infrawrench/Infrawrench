/**
 * Guarding the rest of a prefix a Hono router used to own whole.
 *
 * A Hono sub-app with `app.use("*", auth)` authenticated every request under
 * its mount, routed or not: an unknown path or method there answered 401 to a
 * caller without a credential, and fell through to the 404 only for one with
 * a credential. HttpApi middleware only wraps the endpoints it is declared on,
 * so a domain replacing such a router guards the rest of the prefix with
 * {@link guardPrefixes}: every method on `prefix` and `prefix/*` that no
 * endpoint routes (FindMyWay prefers the endpoints' static and parametric
 * segments to the wildcard) runs `guard`, which either answers (the 401) or
 * lets the request fall through to Hono, where nothing routes it either and
 * the same 404 as before is sent.
 *
 * The prefix must be the domain's alone: `http/__tests__/domains.test.ts`
 * fails when a Hono route sits under a guarded prefix.
 */
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { AuthSession } from "../api/auth-middleware";
import type { Domain } from "./domain";
import { renderDefect } from "./middleware";
import { SessionAuth } from "./middleware-tags";
import { SessionPrincipal } from "./principal";
import { UNMATCHED_HEADER } from "./server";

/**
 * Answers a request under the prefix that no endpoint routes, or returns
 * `undefined` to let it fall through. A defect renders as the API's errors do.
 */
export type PrefixGuard = Effect.Effect<
  HttpServerResponse.HttpServerResponse | undefined,
  never,
  HttpServerRequest.HttpServerRequest
>;

/** A method the router takes a route for: `"*"` or one HTTP method. */
type RouteMethod = Parameters<typeof HttpRouter.add>[0];

const fallThrough = () =>
  HttpServerResponse.empty({ status: 404, headers: { [UNMATCHED_HEADER]: "1" } });

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
    Effect.map((response) => response ?? fallThrough()),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.succeed(renderDefect(Cause.squash(cause))),
    ),
  );
  // `prefix/*` registers `prefix` as well.
  const routes = prefixes.flatMap((prefix) =>
    methods.map((method) => HttpRouter.add(method, `${prefix}/*`, handler)),
  );
  return {
    ...domain,
    layer: Layer.mergeAll(domain.layer, ...routes),
    guardedPrefixes: [...(domain.guardedPrefixes ?? []), ...prefixes],
  };
}

/**
 * What the session guard hands the middleware as "the endpoint": neither
 * implementation reads it, but the middleware contract passes one, typed as
 * the router hands it over.
 */
const sessionGuardTarget = (): {
  readonly endpoint: HttpApiEndpoint.Top;
  readonly group: HttpApiGroup.Top;
} => {
  const targets: Array<{ endpoint: HttpApiEndpoint.Top; group: HttpApiGroup.Top }> = [];
  HttpApi.reflect(
    HttpApi.make("sessionGuard").add(
      HttpApiGroup.make("sessionGuard").add(HttpApiEndpoint.get("sessionGuard", "/")),
    ),
    { onGroup() {}, onEndpoint: ({ endpoint, group }) => void targets.push({ endpoint, group }) },
  );
  const [target] = targets;
  if (!target) throw new Error("the session guard's endpoint did not reflect");
  return target;
};

/** The methods the guard takes on a bare prefix an endpoint does not already route. */
const BARE_PREFIX_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * {@link guardPrefixes} for a prefix the Hono `sessionMiddleware` guarded
 * whole (`authed.use("/profile/*", sessionMiddleware)`): every request under
 * it that no endpoint routes runs {@link SessionAuth}, the middleware the
 * endpoints run, so a caller without a person's session gets the 401 or 403
 * it always did from whichever implementation the server (or a test) provides.
 * `check` refuses an authenticated caller the Hono router also refused before
 * its 404 (the platform-admin allowlist); anything else falls through.
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
      const handler = sessionAuth(
        Effect.gen(function* () {
          const session = yield* SessionPrincipal;
          return check(session) ?? fallThrough();
        }),
        sessionGuardTarget(),
      ).pipe(
        Effect.orDie,
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.succeed(renderDefect(Cause.squash(cause))),
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
  return {
    ...domain,
    layer: Layer.mergeAll(domain.layer, routes),
    guardedPrefixes: [...(domain.guardedPrefixes ?? []), ...prefixes],
  };
}

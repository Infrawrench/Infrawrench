/**
 * Which domain serves a request, without loading any domain.
 *
 * `domain-routes.gen.ts` lists every route each domain's layer registers on
 * the router (its endpoints and any prefix guard), recorded from the layers
 * themselves by `domain-routes-build.ts`, and a dynamic import for each
 * domain. {@link routeOwner} looks a request up in a `FindMyWay` built from
 * that list, the router `HttpRouter` itself uses, configured the same way, so
 * the route it picks is the one the full router would run. The edge Worker
 * (`api/edge.ts`) then loads and serves that one domain.
 */
import { FindMyWay, type HttpMethod } from "effect/http";

/** A method as the router takes it: `"*"` for every method. */
export type RouteMethod = "*" | HttpMethod.HttpMethod;

/** One route a domain registers: `[domain name, method, router path]`. */
export type DomainRoute = readonly [domain: string, method: RouteMethod, path: string];

/** The name `orgTreeGuard` registers under; served beside every domain. */
export const ORG_TREE_GUARD = "org-tree-guard";

/**
 * Register `routes` the way `HttpRouter.make`'s `addAll` does: a `"*"` method
 * on every method, and a `prefix/*` path on the bare prefix too.
 */
export function makeRouteTable(routes: readonly DomainRoute[]): FindMyWay.Router<DomainRoute> {
  // `HttpRouter.make` passes its `RouterConfig`, which `makeHttpApiHandler`
  // leaves at the default, so the defaults here are the router's.
  const table = FindMyWay.make<DomainRoute>();
  for (const route of routes) {
    const [, method, path] = route;
    const paths = path.endsWith("/*") ? [path, path.slice(0, -2)] : [path];
    for (const p of paths) {
      const routerPath = p as FindMyWay.PathInput;
      if (method === "*") table.all(routerPath, route);
      else table.on(method, routerPath, route);
    }
  }
  return table;
}

/**
 * The route the router would run for `method` and `url` (path plus query), if
 * any. HEAD is looked up as the GET `makeHttpApiHandler` serves it as.
 */
export function findRoute(
  table: FindMyWay.Router<DomainRoute>,
  method: string,
  url: string,
): DomainRoute | undefined {
  return table.find(method === "HEAD" ? "GET" : method, url)?.handler;
}

/**
 * The domain that owns the route the router would run, `undefined` when only
 * the org tree's guard or nothing at all matches.
 */
export function routeOwner(
  table: FindMyWay.Router<DomainRoute>,
  method: string,
  url: string,
): string | undefined {
  const owner = findRoute(table, method, url)?.[0];
  return owner === ORG_TREE_GUARD ? undefined : owner;
}

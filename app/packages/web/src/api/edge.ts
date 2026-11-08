/**
 * The web API as the edge Worker serves it: the same router as `api`
 * (`./index.ts`), loaded one domain at a time.
 *
 * `api` imports every domain and builds every domain's routes before it
 * answers anything. On a fresh Worker isolate that cost 1.0 to 1.7 s of CPU
 * (#911), and a page load after a quiet spell meets several fresh isolates at
 * once. Here a request is matched against the recorded route table
 * (`http/domain-routes.gen.ts`, see `http/domain-routes.ts`) without loading
 * any domain; only the domain that owns the route is imported, and a handler
 * over it and the org tree's guard is built once per isolate and kept.
 *
 * What a request gets is what `api` would answer: the table holds every route
 * every domain registers, so the domain it picks owns the route the full
 * router runs, and that route is in the handler built for it (the subset
 * holds no route the full router prefers). A request no domain routes gets
 * the guard-only handler, which answers it as `api` does: the org tree's 401,
 * 403 or 404 under `/api/org/:orgId`, and the 404 anywhere else.
 * `__tests__/edge.test.ts` checks the routing against the full router.
 *
 * Node (`server.ts`) and the Lambda gateway keep `api`: a long-lived process
 * or a SnapStart snapshot pays the full load once, not per isolate.
 */
import { makeRouteTable, routeOwner } from "../http/domain-routes";
import { DOMAIN_LOADERS, DOMAIN_ROUTES } from "../http/domain-routes.gen";
import { MiddlewareLive } from "../http/middleware-live";
import { orgTreeGuard } from "../http/prefix-guard";
import { makeHttpApiHandler, type HttpApiHandler } from "../http/server";

const table = makeRouteTable(DOMAIN_ROUTES);

/** Handlers by owning domain (`""` for none), built on first use and kept. */
const handlers = new Map<string, Promise<HttpApiHandler>>();

function handlerFor(owner: string | undefined): Promise<HttpApiHandler> {
  const key = owner ?? "";
  let handler = handlers.get(key);
  if (!handler) {
    const load = owner === undefined ? undefined : DOMAIN_LOADERS[owner];
    handler = (load ? load() : Promise.resolve(undefined)).then((domain) =>
      makeHttpApiHandler(domain ? [domain, orgTreeGuard()] : [orgTreeGuard()], MiddlewareLive),
    );
    // A failed import must not be cached: let the next request try again.
    handler.catch(() => handlers.delete(key));
    handlers.set(key, handler);
  }
  return handler;
}

/** The domain that serves `request`, if any (for tests and logs). */
export function edgeRouteOwner(request: Request): string | undefined {
  const url = new URL(request.url);
  return routeOwner(table, request.method, `${url.pathname}${url.search}`);
}

export const edgeApi = {
  /** Serve one request, as `api.fetch` does. */
  async fetch(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response> {
    const handler = await handlerFor(edgeRouteOwner(request));
    return handler.handle(request, env, executionCtx);
  },
};

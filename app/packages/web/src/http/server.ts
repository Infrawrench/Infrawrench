/**
 * Serving the HttpApi domains.
 *
 * Every domain in `./domains.ts` registers on one Effect router, which runs as
 * the first middleware of the Hono `api` app: it answers what a domain routes
 * and passes everything else down the Hono stack. `api` is still a Hono app,
 * so `server.ts`, the edge Worker, the Lambda handler and the tests reach both
 * halves through one `fetch`. Once the last route moves, the router becomes
 * the server and the `Unmatched` route its 404.
 */
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { securityHeaderEntries } from "../api/security-headers";
import type { Domain, DomainRequirements } from "./domain";
import { ambientLegacyScopes, LegacyScopes } from "./legacy";
import type { OrgAuth, RequestErrors, SessionAuth } from "./middleware";

/** What Hono's `fetch` takes besides the request, for handlers that need Worker bindings. */
export interface InvocationEnv {
  readonly env: unknown;
  readonly executionCtx: unknown;
}

/** The Worker bindings and execution context of this invocation (edge only). */
export class Invocation extends Context.Service<Invocation, InvocationEnv>()(
  "infrawrench/http/Invocation",
) {}

/** Marks the response to a request no domain routes; never sent to a client. */
export const UNMATCHED_HEADER = "x-infrawrench-httpapi-unmatched";

export interface HttpApiHandler {
  /** Serve `request` if a domain routes it; `undefined` when none does. */
  handle(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response | undefined>;
}

const SecurityHeaders = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      HttpServerResponse.setHeaders(response, Object.fromEntries(securityHeaderEntries())),
    ),
  { global: true },
);

const Unmatched = HttpRouter.add(
  "*",
  "*",
  Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { [UNMATCHED_HEADER]: "1" } })),
);

/**
 * Build the handler over `domains`. `middleware` replaces the auth and error
 * middleware implementations, which is how the route tests run a domain as a
 * fixed caller.
 */
export function makeHttpApiHandler(
  domains: readonly Domain[],
  middleware: Layer.Layer<OrgAuth | SessionAuth | RequestErrors>,
): HttpApiHandler {
  const domainRoutes = domains.reduce<Layer.Layer<never, never, DomainRequirements>>(
    (acc, domain) => Layer.merge(acc, domain.layer),
    Layer.empty,
  );
  const App = Layer.mergeAll(domainRoutes, Unmatched, SecurityHeaders).pipe(
    Layer.provide(middleware),
    Layer.provide(HttpServer.layerServices),
  );

  let web: ReturnType<typeof makeWebHandler> | undefined;
  const makeWebHandler = () => HttpRouter.toWebHandler(App, { disableLogger: true });

  return {
    async handle(request, env, executionCtx) {
      // Built on first use rather than at import: the edge Worker's startup
      // budget does not cover evaluating every domain's layer.
      web ??= makeWebHandler();
      // Captured here, synchronously, where the ambient store is the caller's
      // own: the edge and Lambda wrappers enter the request scope around the
      // Hono app this runs inside.
      const context = Context.make(Invocation, { env, executionCtx }).pipe(
        Context.add(LegacyScopes, ambientLegacyScopes()),
      );
      const response = await web.handler(asJsonBody(request), context);
      return response.headers.get(UNMATCHED_HEADER) === "1" ? undefined : response;
    },
  };
}

/**
 * Content types a JSON body has always been accepted under. Hono's
 * `c.req.json()` parsed the body whatever the header said, and HttpApi picks a
 * decoder by content type, answering 415 for one it has none for. A
 * `fetch(url, { body: JSON.stringify(x) })` without a header sends
 * `text/plain`, and `curl -d` sends a form type, so callers that always
 * worked would start failing. Their bodies are read as JSON, as before;
 * multipart and binary uploads keep their type.
 */
const READ_AS_JSON = new Set(["text/plain", "application/x-www-form-urlencoded"]);

function asJsonBody(request: Request): Request {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return request;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!READ_AS_JSON.has(mediaType)) return request;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request, { headers });
}

/**
 * Hono middleware serving every HttpApi domain ahead of the Hono routes. A
 * request no domain routes continues down the Hono stack untouched (nothing
 * has read its body), which is what lets routes move a domain at a time.
 */
export const httpApiMiddleware = (handler: HttpApiHandler): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    let executionCtx: unknown;
    try {
      executionCtx = c.executionCtx;
    } catch {
      // Node has none; Hono's getter throws rather than answering undefined.
    }
    const response = await handler.handle(c.req.raw, c.env, executionCtx);
    if (response === undefined) return next();
    return response;
  });

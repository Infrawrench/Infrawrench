/**
 * Serving the HttpApi domains: the web server's request handler.
 *
 * Every domain in `./domains.ts` registers on one Effect router, which is the
 * whole API: `api` (`api/index.ts`) is this handler over every domain plus the
 * org tree's guard, and `server.ts`, the edge Worker, the Lambda handler and
 * the tests all call it through `fetch`. A request no route matches gets the
 * {@link notFound} answer every unknown path has always had, with the
 * security headers.
 */
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { securityHeaderEntries } from "../api/security-headers";
import type { Domain, DomainRequirements } from "./domain";
import { ambientLegacyScopes, LegacyScopes } from "./legacy";
import type { OrgAuth, RequestErrors, SessionAuth } from "./middleware";

/** What a `fetch` takes besides the request, for handlers that need Worker bindings. */
export interface InvocationEnv {
  readonly env: unknown;
  readonly executionCtx: unknown;
}

/** The Worker bindings and execution context of this invocation (edge only). */
export class Invocation extends Context.Service<Invocation, InvocationEnv>()(
  "infrawrench/http/Invocation",
) {}

export interface HttpApiHandler {
  /** Serve `request`: what a domain routes, or {@link notFound}. */
  handle(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response>;
}

/**
 * The answer to a path nothing routes, byte for byte the `404 Not Found` text
 * the API has always sent for one (Hono's default not-found handler, while the
 * API ran on Hono). The prefix guards (`./prefix-guard.ts`) answer it too,
 * once the caller has passed their check.
 */
export const notFound = () =>
  HttpServerResponse.text("404 Not Found", {
    status: 404,
    contentType: "text/plain; charset=UTF-8",
  });

const SecurityHeaders = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      HttpServerResponse.setHeaders(response, Object.fromEntries(securityHeaderEntries())),
    ),
  { global: true },
);

const Unmatched = HttpRouter.add("*", "*", Effect.sync(notFound));

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
      // own: the edge and Lambda wrappers enter the request scope around this.
      const context = Context.make(Invocation, { env, executionCtx }).pipe(
        Context.add(LegacyScopes, ambientLegacyScopes()),
      );
      // HEAD is answered as the GET route minus its body, as it always was.
      const head = request.method === "HEAD";
      const routed = head ? new Request(request, { method: "GET" }) : request;
      const response = await web.handler(forRouter(routed), context);
      if (!head) return response;
      await response.body?.cancel();
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

/**
 * Content types a JSON body has always been accepted under. The Hono routes'
 * `c.req.json()` parsed the body whatever the header said, and HttpApi picks a
 * decoder by content type, answering 415 for one it has none for. A
 * `fetch(url, { body: JSON.stringify(x) })` without a header sends
 * `text/plain`, and `curl -d` sends a form type, so callers that always
 * worked would start failing. Their bodies are read as JSON, as before;
 * multipart and binary uploads keep their type. Only the header changes, never
 * the bytes, so a signature over them (Slack's form posts) still verifies.
 */
const READ_AS_JSON = new Set(["text/plain", "application/x-www-form-urlencoded"]);

/**
 * The request as the router sees it. Detached from the client's abort signal:
 * a handler has always run to its end when the client went away, and the
 * Effect web handler would otherwise interrupt it there, between two steps of
 * a write (a row claimed and its work never run). A streamed response still
 * stops when the client stops reading. A JSON body sent under a text or form
 * type gets the JSON type, as above.
 */
function forRouter(request: Request): Request {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!READ_AS_JSON.has(mediaType)) return new Request(request, { signal: null });
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request, { headers, signal: null });
}

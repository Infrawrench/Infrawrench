/**
 * The web app's front door on Cloudflare Workers.
 *
 * Deployed on the `app.infrawrench.com/*` route, in front of the GKE web pods,
 * which become the Node "gateway". For each request it either:
 *
 * - serves the SPA from Workers static assets (`dist/client`), with the same
 *   security headers and hashed-asset 404 rule `server.ts` applies;
 * - runs the Hono API (`src/api`) itself, against Hyperdrive and the private
 *   ClickHouse binding; or
 * - forwards to the gateway: WebSocket sessions, stateful and driver-only
 *   routes (`src/edge/gateway-routes.ts`), and requests about accounts that
 *   need Node (`runtime/account-runtime.ts`).
 *
 * A request the edge runs can still turn out to need Node: on the edge every
 * Node-only library is a stub that throws (and records) a gateway-only error.
 * A GET that hits one is replayed on the gateway, so the user never sees it;
 * a write cannot safely be replayed, so it answers 503 and the account is
 * flagged, which routes the retry to the gateway.
 *
 * Forwarding is a plain `fetch(request)`: a Worker's subrequest to its own
 * route's host goes to the origin rather than back through the Worker, so the
 * gateway keeps its hostname, TLS and ingress unchanged, and removing the
 * route is a complete rollback. `GATEWAY_ORIGIN` overrides that for local
 * development (`wrangler dev` has no origin behind it).
 */
// The importable flavour of the Workers types: loading them as globals on top
// of Node's (which the server code is written against) clashes all over.
import type {
  ExecutionContext,
  ExportedHandler,
  Request as WorkerRequest,
} from "@cloudflare/workers-types/index";
import { securityHeaderEntries } from "../src/api/security-headers";
import { isApiPath, routeRequest } from "../src/edge/gateway-routes";
import { handleEdgeApi } from "../src/edge/handle-api";
import type { EdgeBindings } from "@infrawrench/server-core/runtime/edge-invocation";
import { GATEWAY_ONLY_HEADER } from "@infrawrench/server-core/runtime/gateway-only";
import {
  dbWritesInScope,
  gatewayOnlyHitInScope,
} from "@infrawrench/server-core/runtime/request-scope";

/**
 * The API and everything behind it, loaded on the first API request rather
 * than at startup. Evaluating it (every plugin, ~45 AWS SDK clients, the
 * schema) costs several hundred ms of CPU, past what Workers allow a script's
 * startup; inside a request it is a one-off per isolate, and requests for the
 * SPA never pay it. The specifiers are literal, so it is still one bundle.
 */
let server: Promise<{
  api: (typeof import("../src/api/index"))["api"];
  withEdgeInvocation: (typeof import("@infrawrench/server-core/runtime/edge-invocation"))["withEdgeInvocation"];
  accounts: typeof import("@infrawrench/server-core/runtime/account-runtime");
}> | null = null;
function loadServer() {
  server ??= Promise.all([
    import("../src/api/index"),
    import("@infrawrench/server-core/runtime/edge-invocation"),
    import("@infrawrench/server-core/runtime/account-runtime"),
  ]).then(([apiModule, invocation, accounts]) => ({
    api: apiModule.api,
    withEdgeInvocation: invocation.withEdgeInvocation,
    accounts,
  }));
  // A failed load must not be cached: let the next request try again.
  server.catch(() => {
    server = null;
  });
  return server;
}

export interface Env extends EdgeBindings {
  /** The static assets binding, typed against the global Request/Response. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Local development only: where the Node gateway listens. */
  GATEWAY_ORIGIN?: string;
}

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of securityHeaderEntries()) out.headers.set(name, value);
  out.headers.delete(GATEWAY_ONLY_HEADER);
  return out;
}

function forwardToGateway(request: Request, env: Env): Promise<Response> {
  if (!env.GATEWAY_ORIGIN) return fetch(request);
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.GATEWAY_ORIGIN);
  const forwarded = new Request(target, request);
  forwarded.headers.set("x-forwarded-host", url.host);
  return fetch(forwarded);
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const { pathname } = new URL(request.url);
  // A hashed asset that does not exist must 404, never fall back to
  // index.html: a 200 text/html under a .js URL is cached by extension at the
  // CDN for hours, breaking the app for everyone (see server.ts). no-store
  // keeps the miss out of the cache so the browser recovers on reload.
  if (
    pathname.startsWith("/assets/") &&
    response.headers.get("content-type")?.startsWith("text/html")
  ) {
    return withSecurityHeaders(
      new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }),
    );
  }
  return withSecurityHeaders(response);
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  accountId: string | undefined,
): Promise<Response> {
  const { api, withEdgeInvocation, accounts } = await loadServer();
  return withEdgeInvocation(env, ctx, () =>
    handleEdgeApi(request, accountId, {
      apiFetch: async (req) => api.fetch(req, env, ctx),
      forward: (req) => forwardToGateway(req, env),
      accountNeedsGateway: accounts.accountNeedsGateway,
      markAccountRequiresGateway: accounts.markAccountRequiresGateway,
      gatewayOnlyHit: gatewayOnlyHitInScope,
      dbWrites: dbWritesInScope,
      waitUntil: (promise) => ctx.waitUntil(promise),
    }),
  );
}

const handler: ExportedHandler<Env> = {
  async fetch(incoming: WorkerRequest, env: Env, ctx: ExecutionContext) {
    // The runtime's Request and the global one are the same object; the cast
    // only reconciles the two type libraries.
    const request = incoming as unknown as Request;
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return withSecurityHeaders(new Response("ok", { headers: { "content-type": "text/plain" } }));
    }
    if (!isApiPath(pathname)) return serveAsset(request, env);

    const route = routeRequest(request.method, pathname, request.headers.get("upgrade"));
    // Upgrades pass through untouched: the 101 and its socket are the gateway's.
    if (route.target === "gateway") return forwardToGateway(request, env);
    return withSecurityHeaders(await handleApi(request, env, ctx, route.accountId));
  },
} as ExportedHandler<Env>;

export default handler;

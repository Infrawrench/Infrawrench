/**
 * The web app's front door on Cloudflare Workers.
 *
 * Deployed on the `app.infrawrench.com/*` route, in front of two Node
 * gateways: the **Lambda gateway** (`lambda/handler.ts`, on AWS Lambda) for
 * Node work that finishes within a request, and the **session gateway** (the
 * GKE web pods running `server.ts`) for what needs a long-lived process. For
 * each request it either:
 *
 * - serves the SPA from Workers static assets (`dist/client`), with the same
 *   security headers and hashed-asset 404 rule `server.ts` applies;
 * - runs the Hono API (`src/api`) itself, against Hyperdrive and the private
 *   ClickHouse binding; or
 * - forwards to Node, with `src/edge/gateway-routes.ts` choosing the tier:
 *   WebSocket sessions and stateful routes to the session gateway; driver-only
 *   routes, plugin calls and requests about accounts that need Node
 *   (`runtime/account-runtime.ts`) to the Lambda gateway.
 *
 * A request the edge runs can still turn out to need Node: on the edge every
 * Node-only library is a stub that throws (and records) a gateway-only error.
 * A GET that hits one is replayed on Node, so the user never sees it; a write
 * cannot safely be replayed, so it answers 503 and the account is flagged,
 * which routes the retry to Node. The Lambda gateway falls back the same way,
 * one tier up: work that needs process-local state (a bastion agent) comes
 * back as a 421 handoff, and this Worker replays its copy of the request on
 * the session gateway (`src/lambda/protocol.ts`).
 *
 * Forwarding to the session gateway is a plain `fetch(request)`: a Worker's
 * subrequest to its own route's host goes to the origin rather than back
 * through the Worker, so the gateway keeps its hostname, TLS and ingress
 * unchanged, and removing the route is a complete rollback. `GATEWAY_ORIGIN`
 * overrides that for local development (`wrangler dev` has no origin behind
 * it). Without `LAMBDA_GATEWAY_URL` all Node work goes to the session gateway,
 * exactly as before the Lambda tier existed, so unsetting it rolls the Lambda
 * back.
 */
// The importable flavour of the Workers types: loading them as globals on top
// of Node's (which the server code is written against) clashes all over.
import type {
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  Request as WorkerRequest,
} from "@cloudflare/workers-types/index";
import { securityHeaderEntries } from "../src/api/security-headers";
import { isApiPath, routeRequest } from "../src/edge/gateway-routes";
import { handleEdgeApi } from "../src/edge/handle-api";
import { handleRealtime, type AgentAuthenticator, type RealtimeEnv } from "./realtime";
import {
  GATEWAY_SECRET_HEADER,
  LAMBDA_MAX_REQUEST_BYTES,
  SESSION_HANDOFF_HEADER,
} from "../src/lambda/protocol";
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

// The realtime relay's Durable Objects (bindings in wrangler.jsonc).
export { BastionRelay, ConsoleRelay } from "./realtime";

export interface Env extends EdgeBindings, RealtimeEnv {
  /** The static assets binding, typed against the global Request/Response. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Local development only: where the session gateway listens. */
  GATEWAY_ORIGIN?: string;
  /**
   * The Lambda gateway's function URL (`https://<id>.lambda-url.<region>.on.aws`).
   * Unset, or set without the secret, sends all Node work to the session gateway.
   */
  LAMBDA_GATEWAY_URL?: string;
  /** Shared with the Lambda, which refuses any request that lacks it. */
  LAMBDA_GATEWAY_SECRET?: string;
  /** Read by `/api/v1/aws-bulk-pricing` through `c.env`. */
  AWS_BULK_PRICING: KVNamespace;
}

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of securityHeaderEntries()) out.headers.set(name, value);
  out.headers.delete(GATEWAY_ONLY_HEADER);
  return out;
}

function forwardToSession(request: Request, env: Env): Promise<Response> {
  if (!env.GATEWAY_ORIGIN) return fetch(request);
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.GATEWAY_ORIGIN);
  const forwarded = new Request(target, request);
  forwarded.headers.set("x-forwarded-host", url.host);
  return fetch(forwarded);
}

/**
 * Whether a request may go to the Lambda gateway: no body, or a body of known
 * size small enough for a function URL event and for this Worker to keep a
 * copy of (for the replay below). A streamed upload of unknown length goes to
 * the session gateway.
 */
function fitsLambda(request: Request): boolean {
  if (!request.body) return true;
  const length = request.headers.get("content-length");
  return length !== null && Number(length) <= LAMBDA_MAX_REQUEST_BYTES;
}

/**
 * Hand a request to Node: the Lambda gateway when one is configured and the
 * request fits, the session gateway otherwise. A 421 handoff from the Lambda
 * (work that needs process-local state, answered before any write) is
 * replayed on the session gateway, so the user never sees it.
 */
async function forwardToNode(request: Request, env: Env): Promise<Response> {
  if (!env.LAMBDA_GATEWAY_URL || !env.LAMBDA_GATEWAY_SECRET || !fitsLambda(request)) {
    return forwardToSession(request, env);
  }
  const replay = request.clone();
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set(GATEWAY_SECRET_HEADER, env.LAMBDA_GATEWAY_SECRET);
  const response = await fetch(new URL(url.pathname + url.search, env.LAMBDA_GATEWAY_URL), {
    method: request.method,
    headers,
    body: request.body,
    // A redirect (an OAuth callback's) is the browser's to follow.
    redirect: "manual",
  });
  if (response.status === 421 && response.headers.has(SESSION_HANDOFF_HEADER)) {
    return forwardToSession(replay, env);
  }
  return withSecurityHeaders(response);
}

/**
 * Whether a Node-bound request names an account only the session gateway can
 * serve (a bastion-bound one). Only asked when there is a Lambda to choose
 * over it. Deciding up front matters for writes: the Lambda can hand a
 * request back only before it has written anything.
 */
async function needsSession(
  accountId: string | undefined,
  env: Env,
  ctx: ExecutionContext,
): Promise<boolean> {
  if (!accountId || !env.LAMBDA_GATEWAY_URL) return false;
  const { withEdgeInvocation, accounts } = await loadServer();
  return withEdgeInvocation(env, ctx, () => accounts.accountNeedsSession(accountId));
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
      forward: async (req) =>
        accountId && env.LAMBDA_GATEWAY_URL && (await accounts.accountNeedsSession(accountId))
          ? forwardToSession(req, env)
          : forwardToNode(req, env),
      accountNeedsGateway: accounts.accountNeedsGateway,
      markAccountRequiresGateway: accounts.markAccountRequiresGateway,
      gatewayOnlyHit: gatewayOnlyHitInScope,
      dbWrites: dbWritesInScope,
      waitUntil: (promise) => ctx.waitUntil(promise),
    }),
  );
}

/**
 * The bastion agent's token check, run like any API request (the server is
 * loaded, Postgres is a per-invocation client): the agent's socket only reaches
 * its relay object once the token names a live bastion.
 */
function agentAuthenticator(env: Env, ctx: ExecutionContext): () => Promise<AgentAuthenticator> {
  return async () => {
    const [{ withEdgeInvocation }, registry, { keyedHash }] = await Promise.all([
      loadServer(),
      import("@infrawrench/server-core/bastion/registry"),
      import("@infrawrench/server-core/encryption"),
    ]);
    return (token) =>
      withEdgeInvocation(env, ctx, async () => {
        const row = await registry.findBastionByHashedToken(
          await keyedHash(token, "bastion-agent"),
        );
        if (!row) return null;
        const allowlist = await registry.computeAllowlist(row.id);
        await registry.markBastionActive(row.id);
        return { bastionId: row.id, allowlist };
      });
  };
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

    // The realtime relay (bastion agents, Node's relay sockets) ends here,
    // before any routing to the gateways.
    if (env.BASTION_RELAY && env.CONSOLE_RELAY) {
      const relayed = await handleRealtime(request, env, ctx, agentAuthenticator(env, ctx));
      if (relayed) return relayed;
    }

    const route = routeRequest(request.method, pathname, request.headers.get("upgrade"));
    // Upgrades pass through untouched: the 101 and its socket are the gateway's.
    if (route.target === "gateway") {
      return route.tier === "session" || (await needsSession(route.accountId, env, ctx))
        ? forwardToSession(request, env)
        : forwardToNode(request, env);
    }
    return withSecurityHeaders(await handleApi(request, env, ctx, route.accountId));
  },
} as ExportedHandler<Env>;

export default handler;

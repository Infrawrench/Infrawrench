/**
 * The Lambda gateway's request path, kept apart from `lambda/handler.ts` (and
 * free of Lambda globals) so it is testable on Node with its collaborators
 * faked: turning a function URL event into a `Request`, checking it came
 * through the edge, running the API, and handing work that needs the session
 * gateway back to the Worker.
 *
 * The decision logic is the edge's own (`handleEdgeApi`), one tier up. On the
 * edge a gateway-only hit means "this needs Node"; here, where Node-only
 * libraries are real, the only hits are process-local state the Lambda does
 * not hold (bastion agents; see `sessionHandoff` in `runtime/request-scope.ts`),
 * and the handoff target is the session gateway.
 */
import { timingSafeEqual } from "node:crypto";
import { routeRequest } from "../edge/gateway-routes";
import { handleEdgeApi } from "../edge/handle-api";
import { GATEWAY_SECRET_HEADER, SESSION_HANDOFF_HEADER } from "./protocol";

/** The parts of a function URL event (payload format 2.0) this reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    domainName?: string;
    http: { method: string };
  };
}

/**
 * The `Request` the API sees. The URL carries the public host the Worker
 * forwarded for (`x-forwarded-host`), not the function URL's, because the API
 * builds absolute URLs (OAuth redirects, MCP metadata) from it. Function URLs
 * move cookies out of the headers into their own array; they go back here.
 */
export function eventToRequest(event: FunctionUrlEvent): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const host = headers.get("x-forwarded-host") ?? event.requestContext.domainName ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath}${query}`;
  const method = event.requestContext.http.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body!, "base64")
      : event.body!
    : null;
  return new Request(url, { method, headers, body });
}

/** Constant-time check of the Worker's shared secret. An unset secret admits nothing. */
export function hasGatewaySecret(request: Request, secret: string | undefined): boolean {
  const presented = request.headers.get(GATEWAY_SECRET_HEADER);
  if (!secret || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The answer that tells the Worker to replay the request on the session gateway. */
export function sessionHandoff(reason: string): Response {
  return new Response(null, { status: 421, headers: { [SESSION_HANDOFF_HEADER]: reason } });
}

/**
 * Status, headers and cookies for `awslambda.HttpResponseStream.from`. A
 * function URL wants `set-cookie` in its own array (several in one header
 * would be folded into one invalid value).
 */
export function responseMetadata(response: Response): {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
} {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  return { statusCode: response.status, headers, cookies: response.headers.getSetCookie() };
}

export interface LambdaApiDeps {
  /** `LAMBDA_GATEWAY_SECRET`. */
  secret: string | undefined;
  /** The Hono API, run in this process. */
  apiFetch(request: Request): Promise<Response>;
  accountNeedsSession(accountId: string): Promise<boolean>;
  gatewayOnlyHit(): string | undefined;
  dbWrites(): number;
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleLambdaRequest(
  request: Request,
  deps: LambdaApiDeps,
): Promise<Response> {
  if (!hasGatewaySecret(request, deps.secret)) {
    return new Response("Forbidden", { status: 403 });
  }
  // The secret has done its job; nothing downstream should see it.
  const headers = new Headers(request.headers);
  headers.delete(GATEWAY_SECRET_HEADER);
  const inner = new Request(request, { headers });

  const { pathname } = new URL(inner.url);
  if (pathname === "/healthz")
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  const route = routeRequest(inner.method, pathname, inner.headers.get("upgrade"));
  // The Worker never sends these here; answer one that arrives anyway (a
  // Worker deployed before a route moved) by handing it on, not running it.
  if (route.target === "gateway" && route.tier === "session") return sessionHandoff("route");

  return handleEdgeApi(inner, route.accountId, {
    apiFetch: deps.apiFetch,
    forward: async () => sessionHandoff("process-local state"),
    accountNeedsGateway: deps.accountNeedsSession,
    // Nothing to record: what sends an account to the session gateway (its
    // bastion binding) is already a column, read by `accountNeedsSession`.
    markAccountRequiresGateway: async () => {},
    gatewayOnlyHit: deps.gatewayOnlyHit,
    dbWrites: deps.dbWrites,
    waitUntil: deps.waitUntil,
  });
}

/**
 * The edge Worker's API path: run the request here, and fall back to the Node
 * gateway when it turns out to need one. Kept apart from `edge/worker.ts` (and
 * free of Worker types) so the decision logic is testable on Node with its
 * collaborators faked.
 */
import {
  GATEWAY_ONLY_HEADER,
  GATEWAY_ONLY_MARKER,
} from "@infrawrench/server-core/runtime/gateway-only";
import { isSafeMethod } from "./gateway-routes";

/** Error bodies at most this large are checked for the gateway-only marker. */
const MARKER_SCAN_MAX_BYTES = 64 * 1024;
/**
 * Request bodies at most this large are kept so a write can be replayed on the
 * gateway. Larger uploads (cost-file ingest) are not held twice in a 128 MB
 * isolate; they get the 503.
 */
const REPLAY_BODY_MAX_BYTES = 1024 * 1024;

export interface EdgeApiDeps {
  /** The Hono API, run in this isolate. */
  apiFetch(request: Request): Promise<Response>;
  /** Hand the request to the Node gateway unchanged. */
  forward(request: Request): Promise<Response>;
  accountNeedsGateway(accountId: string): Promise<boolean>;
  markAccountRequiresGateway(accountId: string, reason: string): Promise<void>;
  /** What the invocation's scope recorded, even if a handler swallowed it. */
  gatewayOnlyHit(): string | undefined;
  /** Database writes the invocation has started so far. */
  dbWrites(): number;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Whether the API's answer came from a gateway-only path: recorded in scope
 * (even if a plugin swallowed the error), marked by the error handler, or, for
 * handlers that catch and re-wrap errors themselves, visible in a small error
 * body.
 */
export async function gatewayOnlyReason(
  response: Response,
  recorded: string | undefined,
): Promise<string | null> {
  if (recorded) return recorded;
  if (response.headers.has(GATEWAY_ONLY_HEADER)) return "error handler";
  if (response.status < 400 || !response.body) return null;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MARKER_SCAN_MAX_BYTES) return null;
  const text = await response.clone().text();
  return text.includes(GATEWAY_ONLY_MARKER) ? "error body" : null;
}

export async function handleEdgeApi(
  request: Request,
  accountId: string | undefined,
  deps: EdgeApiDeps,
): Promise<Response> {
  if (accountId && (await deps.accountNeedsGateway(accountId))) {
    return deps.forward(request);
  }
  // Kept for the replay: the API may consume the original. Every request
  // with no body or a small one; a write only replays if it turns out to have
  // written nothing (below).
  const length = Number(request.headers.get("content-length") ?? "0");
  const replayable =
    isSafeMethod(request.method) ||
    !request.body ||
    (request.headers.has("content-length") && length <= REPLAY_BODY_MAX_BYTES);
  const replay = replayable ? request.clone() : null;
  const writesBefore = deps.dbWrites();
  const response = await deps.apiFetch(request);
  const reason = await gatewayOnlyReason(response, deps.gatewayOnlyHit());
  if (!reason) return response;

  if (accountId) {
    deps.waitUntil(deps.markAccountRequiresGateway(accountId, reason).catch(() => {}));
  }
  // A read is safe to run twice, and so is a write that has not written yet:
  // plugin code (the usual gateway-only path) runs before the write it leads
  // to. Replay either where it can succeed, and the user never sees the miss.
  const wrote = deps.dbWrites() > writesBefore;
  if (replay && (isSafeMethod(request.method) || !wrote)) return deps.forward(replay);
  // Anything else may have changed data already, so ask for a retry, which
  // the flag above routes to the gateway when the path names the account.
  console.warn(
    `[edge] ${request.method} ${new URL(request.url).pathname} reached a gateway-only path ` +
      `(${reason}) after writing; add it to src/edge/gateway-routes.ts`,
  );
  return new Response(
    JSON.stringify({ error: "This request could not be completed here. Please try again." }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } },
  );
}

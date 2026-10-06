/**
 * The edge/gateway split's one shared signal.
 *
 * Most of the server runs on Cloudflare Workers (the "edge"); the parts that
 * need a real Node process (socket database drivers, SSH, kubectl, Docker,
 * bastion agents, the workflow isolate) run on the Node "gateway". Nothing
 * keeps a list of which plugins or routes need which: on the edge, every
 * Node-only library is aliased to a stub (`edge/gateway-only-stub.cjs`) that
 * throws this error the moment it is used, and the callers that can recover
 * (the edge router, the edge poller) catch it and hand the work to the
 * gateway instead.
 *
 * The stub is plain CommonJS, so it cannot `instanceof` this class; both
 * recognise the error by its `code`. {@link isGatewayOnlyError} also walks the
 * `cause` chain and falls back to the message marker, because plugin and ORM
 * code routinely wraps errors on the way up.
 */

import { noteGatewayOnlyHit, trackGatewayOnlyHits } from "./request-scope";

export const GATEWAY_ONLY_CODE = "IW_GATEWAY_ONLY";
export const GATEWAY_ONLY_MARKER = "[gateway-only]";
/**
 * Set by the API's error handler on a response whose handler hit a
 * gateway-only path, so the edge router (which sees only the Response) knows
 * to replay the request on the gateway. Never reaches a client.
 */
export const GATEWAY_ONLY_HEADER = "x-iw-gateway-only";

export class GatewayOnlyError extends Error {
  readonly code = GATEWAY_ONLY_CODE;
  constructor(what: string, options?: { cause?: unknown }) {
    super(
      `${GATEWAY_ONLY_MARKER} ${what} needs the Node gateway and cannot run on the edge`,
      options,
    );
    this.name = "GatewayOnlyError";
    noteGatewayOnlyHit(what);
  }
}

/** True for a {@link GatewayOnlyError}, the stub's error, or anything wrapping either. */
export function isGatewayOnlyError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 8; depth++) {
    if (typeof e !== "object") {
      return typeof e === "string" && e.includes(GATEWAY_ONLY_MARKER);
    }
    const rec = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === GATEWAY_ONLY_CODE) return true;
    if (typeof rec.message === "string" && rec.message.includes(GATEWAY_ONLY_MARKER)) return true;
    e = rec.cause;
  }
  return false;
}

const EDGE_FLAG = Symbol.for("infrawrench.edgeRuntime");
/** The stub calls this (if present) before it throws; see `edge/gateway-only-stub.cjs`. */
const HIT_HOOK = Symbol.for("infrawrench.gatewayOnlyHit");

/** Called once by each edge entry point before it handles anything. */
export function markEdgeRuntime(): void {
  const g = globalThis as Record<symbol, unknown>;
  g[EDGE_FLAG] = true;
  g[HIT_HOOK] = noteGatewayOnlyHit;
}

/**
 * True inside an edge Worker. Code with a Node-only fast path (undici
 * dispatchers, the in-process bastion registry) branches on this rather than
 * on feature detection, which `nodejs_compat` makes unreliable.
 */
export function isEdgeRuntime(): boolean {
  return (globalThis as Record<symbol, unknown>)[EDGE_FLAG] === true;
}

/**
 * Run `fn`, and fail with a {@link GatewayOnlyError} if it reached a
 * gateway-only path, whether or not something inside caught the error. For
 * work whose result must not be trusted when that happens (a resource listing
 * that fell back to placeholders). Just `fn()` off the edge.
 */
export async function runGatewayChecked<T>(fn: () => Promise<T>): Promise<T> {
  if (!isEdgeRuntime()) return fn();
  const outcome = await trackGatewayOnlyHits(fn);
  if (outcome.hit) {
    const cause = outcome.ok ? undefined : outcome.error;
    if (cause !== undefined && isGatewayOnlyError(cause)) throw cause;
    throw new GatewayOnlyError(outcome.hit, cause === undefined ? undefined : { cause });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

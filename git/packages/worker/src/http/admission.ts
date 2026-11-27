/**
 * Whether a request is let in, before anything is done for it, and what its
 * answer adds to the counts (`rate-limit.ts` has the design and its limits).
 *
 * Two things are decided here, both from the request alone:
 *
 * - **A caller without a credential** is counted by address against the
 *   anonymous budgets: cheap reads, heavy reads (a clone, a comparison, an
 *   archive), writes. Past a budget the answer is 429.
 * - **A caller whose credentials keep being refused** (a 401 to a request
 *   that brought a token, a password or a session) is refused for the rest
 *   of the window once there have been too many, which is what bounds
 *   guessing tokens. The limit is generous: a build machine with an expired
 *   token retries, and many people can share one address.
 *
 * - **A caller with a credential that is accepted** is counted once it is
 *   known who it is (`admit`): by the API's authentication and by the Git
 *   routes, each right after it resolves the principal. It is counted by
 *   principal and never by address, which would hold a whole office to one
 *   visitor's budget, against the signed-in budgets: the same three classes,
 *   four times as generous.
 *
 * The UI's own files are never counted.
 *
 * The counts live in Cloudflare's Rate Limiting bindings where the Worker
 * has them (`RL_*`, optional in `Env`), else in the data centre's cache,
 * else in the isolate. Each is best effort in its own way; none fails a
 * request when it cannot count.
 */
import { IMAGE_PROXY_PATH } from "@infrawrench/git-contract";
import type { Principal } from "../auth/principal";
import type { Env } from "../env";
import {
  type CacheLike,
  type FailureLimiter,
  cacheFailureLimiter,
  defaultCache,
  rateLimitKey,
} from "../transport/ssh/rate-limit";
import {
  type CounterStore,
  type RateLimiter,
  bindingLimiter,
  cacheCounterStore,
  classify,
  memoryCounterStore,
  refusedCredential,
  subjectOf,
  subjectOfPrincipal,
  tooManyRequests,
  windowLimiter,
} from "./rate-limit";

/** Refused credentials from one address before it is refused outright, and for how long. */
export const CREDENTIAL_FAILURE_LIMITS = { maxFailures: 60, windowSeconds: 600 } as const;

export interface Admission {
  /** The 429 for a request that is not let in, or null. */
  refuse(request: Request): Promise<Response | null>;
  /** Counts a refused credential. Resolves when it is written down. */
  record(request: Request, response: Response): Promise<void>;
  /**
   * Counts a request against the caller it authenticated as. The 429 when
   * that caller is past its budget for this kind of request, or null: for
   * the request that may go ahead, and for an anonymous caller, who was
   * counted by address already.
   */
  admit(request: RequestShape, principal: Principal): Promise<Response | null>;
}

/** `Admission.admit`, as the routes that authenticate take it. */
export type Admit = Admission["admit"];

/** What `admit` reads of a request: enough to say what it costs. */
export interface RequestShape {
  readonly method: string;
  readonly url: string;
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-)?iwg-session=/;

/** Whether the request brought something to authenticate with. */
export const presentsCredential = (request: Request): boolean =>
  request.headers.has("authorization") ||
  new URL(request.url).searchParams.has("token") ||
  SESSION_COOKIE.test(request.headers.get("cookie") ?? "");

/**
 * Routes that never authenticate, so their caller is counted by address
 * even when a session cookie rides along: the image proxy, which a page
 * with many images asks often.
 */
const countedByAddress = (request: Request): boolean =>
  new URL(request.url).pathname === IMAGE_PROXY_PATH;

/** The counter of refused credentials is kept apart from SSH's, which has its own limit. */
const failureKey = (address: string): string => `http:${rateLimitKey(address)}`;

export const makeAdmission = (limiter: RateLimiter, failures: FailureLimiter): Admission => ({
  async refuse(request) {
    const address = request.headers.get("cf-connecting-ip");
    if (presentsCredential(request) && !countedByAddress(request)) {
      if (address && (await failures.blocked(failureKey(address)).catch(() => false))) {
        return tooManyRequests({
          allowed: false,
          retryAfterSeconds: CREDENTIAL_FAILURE_LIMITS.windowSeconds,
        });
      }
      return null;
    }
    const decision = await limiter
      .take(classify(request.method, new URL(request.url)), subjectOf(request, null))
      .catch(() => null);
    return decision && !decision.allowed ? tooManyRequests(decision) : null;
  },
  async record(request, response) {
    const address = request.headers.get("cf-connecting-ip");
    if (!address || !refusedCredential(request, response)) return;
    await failures.failed(failureKey(address)).catch(() => undefined);
  },
  async admit(request, principal) {
    const subject = subjectOfPrincipal(principal);
    if (subject === null) return null;
    const decision = await limiter
      .take(classify(request.method, new URL(request.url)), subject)
      .catch(() => null);
    return decision && !decision.allowed ? tooManyRequests(decision) : null;
  },
});

let shared: { readonly env: Env; readonly admission: Admission } | null = null;

/** The Worker's admission, made once per isolate. */
export const admissionFor = (env: Env): Admission => {
  if (shared?.env === env) return shared.admission;
  const cache = defaultCache();
  // Cheap reads are counted in the isolate: a cache round trip per page
  // load would cost more than the read. Heavy reads and writes are counted
  // in the data centre's cache, which its isolates share.
  const memory = memoryCounterStore();
  const byDataCentre = cache ? cacheCounterStore(cache as CacheLike) : memory;
  const store: CounterStore = {
    add: (key, ttlSeconds) =>
      (key.startsWith("read:") ? memory : byDataCentre).add(key, ttlSeconds),
  };
  const limiter = bindingLimiter(
    {
      ...(env.RL_READ_ANON ? { "read:anonymous": env.RL_READ_ANON } : {}),
      ...(env.RL_HEAVY_ANON ? { "heavy:anonymous": env.RL_HEAVY_ANON } : {}),
      ...(env.RL_WRITE_ANON ? { "write:anonymous": env.RL_WRITE_ANON } : {}),
      ...(env.RL_READ_SIGNED_IN ? { "read:signedIn": env.RL_READ_SIGNED_IN } : {}),
      ...(env.RL_HEAVY_SIGNED_IN ? { "heavy:signedIn": env.RL_HEAVY_SIGNED_IN } : {}),
      ...(env.RL_WRITE_SIGNED_IN ? { "write:signedIn": env.RL_WRITE_SIGNED_IN } : {}),
    },
    60,
    windowLimiter(store),
  );
  const admission = makeAdmission(limiter, cacheFailureLimiter(cache, CREDENTIAL_FAILURE_LIMITS));
  shared = { env, admission };
  return admission;
};

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
 * A caller with a credential that is accepted is not counted here: who it
 * is, is only known after authentication, and counting it by address would
 * hold a whole office to one visitor's budget. The UI's own files are never
 * counted.
 *
 * The counts live in Cloudflare's Rate Limiting bindings where the Worker
 * has them (`RL_*`, optional in `Env`), else in the data centre's cache,
 * else in the isolate. Each is best effort in its own way; none fails a
 * request when it cannot count.
 */
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
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Host-)?iwg-session=/;

/** Whether the request brought something to authenticate with. */
export const presentsCredential = (request: Request): boolean =>
  request.headers.has("authorization") ||
  new URL(request.url).searchParams.has("token") ||
  SESSION_COOKIE.test(request.headers.get("cookie") ?? "");

/** The counter of refused credentials is kept apart from SSH's, which has its own limit. */
const failureKey = (address: string): string => `http:${rateLimitKey(address)}`;

export const makeAdmission = (limiter: RateLimiter, failures: FailureLimiter): Admission => ({
  async refuse(request) {
    const address = request.headers.get("cf-connecting-ip");
    if (presentsCredential(request)) {
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
    },
    60,
    windowLimiter(store),
  );
  const admission = makeAdmission(limiter, cacheFailureLimiter(cache, CREDENTIAL_FAILURE_LIMITS));
  shared = { env, admission };
  return admission;
};

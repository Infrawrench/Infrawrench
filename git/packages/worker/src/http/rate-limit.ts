/**
 * How many requests one caller may make, by what the request costs.
 *
 * A public repository answers anonymous callers, and some of its reads are
 * the most expensive thing the Worker does: a comparison of two arbitrary
 * commits, a blame, a path's history, an archive, a clone. Each runs inside
 * the repository's Durable Object, one thread shared with its pushes, so a
 * caller who repeats them slows the repository for everyone. Every read is
 * bounded by count already (`repo/queries/session.ts`, git-ops' `Limits`);
 * this bounds how often.
 *
 * - **Who** is counted: the signed-in person by id (whichever of their
 *   credentials they used), an API key, a deploy key and a CI run by theirs
 *   (`subjectOfPrincipal`), an anonymous caller by address
 *   (`CF-Connecting-IP`), an IPv6 address by its /64, which is what one
 *   customer line is given (`rateLimitKey`, shared with SSH).
 * - **What** is counted: four classes with their own budgets. Cheap reads,
 *   heavy reads (`classify` lists them), writes, and refused credentials:
 *   a request whose `iwg_`, `iwk_` or `iwj_` token, Basic password or
 *   session was refused counts against its address, the same counter SSH
 *   keeps for keys that failed (`transport/ssh/rate-limit.ts`).
 * - **The answer** past a budget is 429 with `Retry-After`.
 *
 * The decision is pure (`windowLimiter` over a `CounterStore`), so the
 * tests drive it with a clock and a map. Where the counts live is the
 * honest weakness of every store a Worker has:
 *
 * - `memoryCounterStore`: one isolate's memory. Free and exact for that
 *   isolate, but a data centre runs many isolates and Cloudflare spreads
 *   requests over them, so a caller gets the budget several times over.
 * - `cacheCounterStore`: the data centre's Cache API. Shared by its
 *   isolates, but a read then a write, so concurrent requests can be
 *   counted once, and it may forget early. Per data centre: a caller who
 *   reaches several gets each one's budget.
 * - `bindingLimiter`: Cloudflare's Rate Limiting binding (`ratelimits` in
 *   wrangler), the production answer. Counted by Cloudflare per location
 *   without a storage round trip; it only offers periods of 10 or 60
 *   seconds and says no reason when it refuses, so `Retry-After` is the
 *   period.
 */
import type { Principal } from "../auth/principal";
import { rateLimitKey } from "../transport/ssh/rate-limit";

/** What a request costs the storage. */
export type RateClass = "read" | "heavy" | "write";

/** Whom a request is counted against. */
export interface RateSubject {
  readonly key: string;
  readonly anonymous: boolean;
}

export interface RateBudget {
  /** Requests allowed in one window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export type RateBudgets = Readonly<
  Record<RateClass, { readonly anonymous: RateBudget; readonly signedIn: RateBudget }>
>;

/**
 * The defaults. A page of the code view is a handful of reads; a person
 * paging through a pull request's files makes a heavy read every few
 * seconds. Nothing anonymous writes, so its write budget only answers the
 * requests that would be refused anyway.
 */
export const DEFAULT_RATE_BUDGETS: RateBudgets = {
  read: {
    anonymous: { limit: 300, windowSeconds: 60 },
    signedIn: { limit: 1200, windowSeconds: 60 },
  },
  heavy: {
    anonymous: { limit: 30, windowSeconds: 60 },
    signedIn: { limit: 120, windowSeconds: 60 },
  },
  write: {
    anonymous: { limit: 30, windowSeconds: 60 },
    signedIn: { limit: 120, windowSeconds: 60 },
  },
};

export interface RateDecision {
  readonly allowed: boolean;
  /** Seconds until the window this request was counted in ends. */
  readonly retryAfterSeconds: number;
}

// Classification

/** Reads under `/api/repos/:owner/:repo` that walk history or diff files. */
const HEAVY_REPO_READS = [
  /^\/tree\/last-commits$/,
  /^\/latest-commit$/,
  /^\/commits\/[^/]+$/,
  /^\/commits\/[^/]+\/diff$/,
  /^\/compare(\/diff)?$/,
  /^\/blame$/,
  /^\/branches\/[^/]+\/(files|commits|mergeability)$/,
];

/** Lists that search when asked with `q`: explore, the people finder, issues and branch pages. */
const SEARCHES = [
  /^\/api\/explore\/repos$/,
  /^\/api\/users$/,
  /^\/api\/repos\/[^/]+\/[^/]+\/(issues|branch-pages)$/,
];

/** Query parameters that turn a history page into a filtered walk. */
const WALKING_HISTORY = ["path", "author", "authorEmail", "since", "until", "follow"];

/**
 * The class of a request, from its method and URL alone, so it is decided
 * before anything is read. Writes are every method but GET and HEAD, and a
 * push (`git-receive-pack`). Heavy are the reads listed above, a history
 * page that filters or follows a path, the file table with its last-commit
 * column, archives, raw files, a fetch or clone (`git-upload-pack`), and a
 * search (`SEARCHES`, asked with `q`). Filtering a repository's branches or
 * tags by name is not one: it reads a list the storage already holds.
 */
export function classify(method: string, url: URL): RateClass {
  const path = url.pathname;
  const pushing =
    path.endsWith("/git-receive-pack") ||
    (path.endsWith("/info/refs") && url.searchParams.get("service") === "git-receive-pack");
  if (pushing) return "write";
  if (path.endsWith("/git-upload-pack")) return "heavy";
  if (method !== "GET" && method !== "HEAD") return "write";
  // A search is a pattern match over a table: repositories, people, issues, pull requests.
  if (SEARCHES.some((pattern) => pattern.test(path)) && (url.searchParams.get("q") ?? "") !== "") {
    return "heavy";
  }
  const repo = /^\/api\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(path);
  if (repo) {
    const rest = repo[1] ?? "";
    if (HEAVY_REPO_READS.some((pattern) => pattern.test(rest))) return "heavy";
    if (rest === "/commits" && WALKING_HISTORY.some((key) => url.searchParams.has(key))) {
      return "heavy";
    }
    if (rest === "/tree" && url.searchParams.get("lastCommits") !== "false") return "heavy";
    return "read";
  }
  // `/<owner>/<repo>/archive/...` and `/<owner>/<repo>/raw/...`: whole objects, or all of them.
  if (/^\/[^/]+\/[^/]+\/(archive|raw)\//.test(path)) return "heavy";
  return "read";
}

/**
 * The subject a request is counted against: the person when one is signed
 * in, else the address the request came from. Without an address (a local
 * run) every anonymous request shares one subject.
 */
export function subjectOf(request: Request, userId: string | null): RateSubject {
  if (userId !== null) return { key: `user:${userId}`, anonymous: false };
  const address = request.headers.get("CF-Connecting-IP");
  return { key: `addr:${address ? rateLimitKey(address) : "unknown"}`, anonymous: true };
}

/**
 * The subject a caller who authenticated is counted against, or null for
 * nobody (an anonymous caller is counted by address, before authentication).
 * A person is one subject whichever credential they used: a session, a
 * token and an SSH key share a budget, so minting tokens buys nothing. A job
 * is counted by its run, so one busy repository's runs do not starve each
 * other.
 */
export function subjectOfPrincipal(principal: Principal): RateSubject | null {
  switch (principal.kind) {
    case "anonymous":
      return null;
    case "user":
      return { key: `user:${principal.userId}`, anonymous: false };
    case "api-key":
      return { key: `key:${principal.apiKeyId}`, anonymous: false };
    case "deploy-key":
      return { key: `deploy:${principal.keyId}`, anonymous: false };
    case "job":
      return { key: `job:${principal.runId ?? principal.repositoryId}`, anonymous: false };
  }
}

// Counting

/** Where counts live. `add` counts one and answers the count so far, the new one included. */
export interface CounterStore {
  add(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * Counts in this isolate's memory, at most `maxKeys` of them (the oldest
 * are forgotten first, so many addresses cannot grow it without end).
 */
export function memoryCounterStore(maxKeys = 10_000, now: () => number = Date.now): CounterStore {
  const counts = new Map<string, { count: number; until: number }>();
  return {
    async add(key, ttlSeconds) {
      const at = now();
      const current = counts.get(key);
      const live = current !== undefined && current.until > at ? current : null;
      const next = { count: (live?.count ?? 0) + 1, until: live?.until ?? at + ttlSeconds * 1000 };
      counts.delete(key);
      counts.set(key, next);
      while (counts.size > maxKeys) counts.delete(counts.keys().next().value!);
      return next.count;
    },
  };
}

/** The part of `Cache` this uses. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/**
 * Counts in the data centre's Cache API. A failure to read or write counts
 * as nothing: a lost count lets a caller go a little further, it never
 * refuses anyone.
 */
export function cacheCounterStore(cache: CacheLike): CounterStore {
  const url = (key: string): string => `https://http-rate-limit.invalid/${encodeURIComponent(key)}`;
  return {
    async add(key, ttlSeconds) {
      const hit = await cache.match(url(key)).catch(() => undefined);
      const before = hit ? Number(await hit.text().catch(() => "0")) : 0;
      const count = (Number.isFinite(before) ? before : 0) + 1;
      await cache
        .put(
          url(key),
          new Response(String(count), {
            headers: { "Cache-Control": `max-age=${Math.max(1, ttlSeconds)}` },
          }),
        )
        .catch(() => undefined);
      return count;
    },
  };
}

export interface RateLimiter {
  /** Counts one request of `kind` against `subject` and says whether it may go ahead. */
  take(kind: RateClass, subject: RateSubject): Promise<RateDecision>;
}

/**
 * Fixed windows: each subject and class has a counter per window of
 * `windowSeconds`, aligned to the clock. A caller can make up to twice the
 * budget across a window's edge, which is the price of one counter.
 */
export function windowLimiter(
  store: CounterStore,
  budgets: RateBudgets = DEFAULT_RATE_BUDGETS,
  now: () => number = Date.now,
): RateLimiter {
  return {
    async take(kind, subject) {
      const budget = subject.anonymous ? budgets[kind].anonymous : budgets[kind].signedIn;
      const windowMillis = budget.windowSeconds * 1000;
      const at = now();
      const window = Math.floor(at / windowMillis);
      const end = (window + 1) * windowMillis;
      const retryAfterSeconds = Math.max(1, Math.ceil((end - at) / 1000));
      const count = await store.add(`${kind}:${subject.key}:${window}`, retryAfterSeconds);
      return { allowed: count <= budget.limit, retryAfterSeconds };
    },
  };
}

/** What a `ratelimits` binding in wrangler offers a Worker. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateBindings = Partial<
  Record<`${RateClass}:${"anonymous" | "signedIn"}`, RateLimitBinding>
>;

/**
 * Cloudflare's Rate Limiting binding, one per class and kind of caller
 * (each binding has its own limit and period in wrangler). A class without
 * a binding goes to `fallback`, or is let through.
 */
export function bindingLimiter(
  bindings: RateBindings,
  periodSeconds: 10 | 60 = 60,
  fallback: RateLimiter | null = null,
): RateLimiter {
  return {
    async take(kind, subject) {
      const binding = bindings[`${kind}:${subject.anonymous ? "anonymous" : "signedIn"}`];
      if (!binding) {
        return fallback ? fallback.take(kind, subject) : { allowed: true, retryAfterSeconds: 0 };
      }
      const { success } = await binding
        .limit({ key: subject.key })
        .catch(() => ({ success: true }));
      return { allowed: success, retryAfterSeconds: periodSeconds };
    },
  };
}

/** The answer past a budget. Plain text, which is also what `git` prints. */
export function tooManyRequests(decision: RateDecision): Response {
  return new Response("Too many requests. Try again later.\n", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(Math.max(1, decision.retryAfterSeconds)),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Whether a refused request was refused for its credential: a 401 to a
 * request that brought one (an `Authorization` header, a session cookie,
 * or the archive route's `?token=`). Those are counted against the
 * address, so guessing tokens costs what guessing SSH keys does.
 */
export function refusedCredential(request: Request, response: Response): boolean {
  if (response.status !== 401) return false;
  if (request.headers.has("Authorization")) return true;
  if (new URL(request.url).searchParams.has("token")) return true;
  return /(?:^|;\s*)(?:__Host-)?iwg-session=/.test(request.headers.get("Cookie") ?? "");
}

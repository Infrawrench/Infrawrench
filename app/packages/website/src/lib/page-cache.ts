/**
 * Edge caching for the server-rendered pages.
 *
 * The site renders on demand so that every URL can answer `Accept`. That trades
 * free static-asset serving for worker CPU on each request, and this is what
 * buys it back: the first request for a page renders it, every later one is
 * served from Cloudflare's cache until it expires.
 *
 * **The cache key carries the representation.** Cloudflare's Cache API does not
 * honour `Vary` beyond `Accept-Encoding`, so caching one URL that answers two
 * ways would hand markdown to the next browser that asked for it — the exact
 * bug `Vary: Accept` exists to prevent, reintroduced one layer down. Rather than
 * rely on a header the cache ignores, the markdown representation is stored
 * under a distinct key. The `Vary` header is still sent, for every cache
 * between us and the reader that *does* implement it.
 */

/** How long a rendered page stays in the edge cache. */
export const PAGE_CACHE_SECONDS = 600;

/**
 * The cache key for one representation of a URL.
 *
 * A query parameter rather than a header, because that is the part of the
 * request Cloudflare's Cache API actually keys on. It never reaches an origin —
 * this key is only ever handed to `caches.default`.
 */
function representationKey(url: URL, markdown: boolean): Request {
  const keyUrl = new URL(url);
  if (markdown) keyUrl.searchParams.set("__repr", "md");
  return new Request(keyUrl.toString(), { method: "GET" });
}

/**
 * Serve `build()` through the edge cache.
 *
 * Failures to reach the cache are swallowed deliberately: `caches` is absent in
 * some local and test runtimes, and a page that renders correctly but cannot be
 * cached should still be served rather than 500.
 */
export async function withPageCache(
  url: URL,
  markdown: boolean,
  ctx: ExecutionContext | undefined,
  build: () => Promise<Response>,
): Promise<Response> {
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const key = representationKey(url, markdown);

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // Fall through and render.
    }
  }

  const fresh = await build();
  // Only successful responses are worth storing. A 404 that got cached for ten
  // minutes would outlive the typo that caused it.
  if (cache && fresh.ok && fresh.headers.get("Cache-Control")) {
    const stored = fresh.clone();
    try {
      const put = cache.put(key, stored);
      if (ctx) ctx.waitUntil(put);
      else await put;
    } catch {
      // Not cacheable (streamed body, runtime without a cache) — serve it anyway.
    }
  }
  return fresh;
}

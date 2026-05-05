export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext | undefined,
  build: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const fresh = await build();
  if (fresh.ok && fresh.headers.get("Cache-Control")) {
    const toCache = fresh.clone();
    if (ctx) {
      ctx.waitUntil(cache.put(request, toCache));
    } else {
      await cache.put(request, toCache);
    }
  }
  return fresh;
}

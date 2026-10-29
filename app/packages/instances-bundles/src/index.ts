/**
 * instances-bundles.infrawrench.com: authenticated, cached reads of the
 * `instances-bundles` R2 bucket.
 *
 * `GET /<key>` (or `HEAD`) with `Authorization: Bearer <credential>` returns
 * the object stored under `<key>`. The credential is anything the Infrawrench
 * API accepts as a bearer token: an `iwk_` API key, an agent credential, or a
 * WorkOS access token. There is no per-object authorization; every caller the
 * API recognises can read every object, which is what makes one shared cache
 * entry per object correct.
 *
 * Two entrypoints, one Worker, with Workers Caching between them:
 *
 * - The default export is the gateway. Caching is disabled on it in
 *   `wrangler.jsonc`, so it runs on every request: it authenticates, strips the
 *   credential, and forwards to {@link Bundles} through `ctx.exports`.
 * - {@link Bundles} reads R2. Caching is enabled on it, so a hit (tiered across
 *   data centres, with concurrent misses collapsed into one R2 read) never runs
 *   it at all. Range requests are sliced by the cache from the stored full
 *   object, and expired entries revalidate with the R2 ETag.
 *
 * Authentication asks the API (`GET /api/v1/whoami`, over the `API` service
 * binding to the web Worker) and remembers a yes for `AUTH_CACHE_SECONDS`
 * (`bundles.ts`) in this data centre's Cache API, keyed by a hash of the credential. A revoked
 * key therefore keeps working here for at most that long. A no is never
 * remembered, so a freshly minted key works at once.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

import {
  ALLOWED_METHODS,
  CLIENT_CACHE_CONTROL,
  authenticate,
  bearerToken,
  objectKey,
  readObject,
  text,
  unauthorized,
} from "./bundles";

export interface Env {
  BUNDLES: R2Bucket;
  /** Service binding to the web Worker (`infrawrench-web`). */
  API: Fetcher;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method not allowed", { allow: ALLOWED_METHODS });
    }

    const url = new URL(request.url);
    if (objectKey(url) === "") return text(404, "Not found");

    const token = bearerToken(request);
    if (!token) return unauthorized();

    const verdict = await authenticate(token, env, ctx);
    if (verdict === "unavailable") {
      return text(503, "Authentication is temporarily unavailable", { "retry-after": "5" });
    }
    if (verdict === "denied") return unauthorized();

    // Nothing that identifies the caller may reach the cached entrypoint: an
    // `Authorization` header there makes every response a cache BYPASS, and a
    // cookie has no business in a shared cache key. The query string goes too:
    // R2 ignores it, so keeping it would only split one object across entries.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    url.search = "";
    const forwarded = new Request(url, { method: request.method, headers });

    const response = await ctx.exports.Bundles.fetch(forwarded);
    const out = new Response(response.body, response);
    out.headers.set("cache-control", CLIENT_CACHE_CONTROL);
    return out;
  },
} satisfies ExportedHandler<Env>;

/**
 * The cached read. Only ever reached through the gateway above (it is not
 * routed), and only ever with the caller's credential already removed.
 */
export class Bundles extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return readObject(this.env.BUNDLES, request);
  }
}

/**
 * The pieces of the instances-bundles Worker that are not entrypoints: the R2
 * read, the authentication check and the small helpers around them. They live
 * apart from `index.ts` because workerd treats every export of the entry module
 * as a handler and refuses to start on anything else (a constant, say).
 */

import type { Env } from "./index";

/** How long a credential the API accepted is trusted without asking again. */
export const AUTH_CACHE_SECONDS = 60;

/**
 * Edge freshness for an object that was uploaded without a `Cache-Control` of
 * its own. After it lapses the cache revalidates against R2 by ETag (cheap when
 * unchanged), serving the stale copy meanwhile. Upload immutable, versioned keys
 * with `Cache-Control: public, max-age=31536000, immutable` to skip that.
 */
export const DEFAULT_EDGE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

/** A miss is remembered briefly, so a hammered missing key does not hit R2 each time. */
const NOT_FOUND_CACHE_CONTROL = "public, max-age=30";

/**
 * What the client sees. The body sits behind authentication, so no shared cache
 * downstream of us may keep it; the browser or download tool may, but has to
 * revalidate (a cheap 304) before reusing it.
 */
export const CLIENT_CACHE_CONTROL = "private, no-cache";

/** Origin used only to address the web Worker through its service binding. */
const API_ORIGIN = "https://app.infrawrench.com";

export const ALLOWED_METHODS = "GET, HEAD";

/**
 * Serve one object from R2; what the cached `Bundles` entrypoint runs.
 *
 * Normally this sees no `Range` header (the cache strips it, fetches the full
 * object, and slices). It still honours one, so the Worker behaves when the
 * cache stands aside: under `wrangler dev`, or for an object over the cacheable
 * size limit. A `206` is never cached, which is what the cache wants anyway.
 */
export async function readObject(bucket: R2Bucket, request: Request): Promise<Response> {
  const key = objectKey(new URL(request.url));

  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return notFound();
    return new Response(null, { headers: objectHeaders(object) });
  }

  const object = await bucket.get(key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) return notFound();

  const headers = objectHeaders(object);

  // No body means a precondition failed. `If-None-Match`/`If-Modified-Since`
  // failing is the ordinary "you already have it" (and how the cache
  // revalidates an expired entry); `If-Match`/`If-Unmodified-Since` failing is
  // a real conflict.
  if (!("body" in object)) {
    const notModified =
      request.headers.has("if-none-match") || request.headers.has("if-modified-since");
    return new Response(null, { status: notModified ? 304 : 412, headers });
  }

  const range = object.range;
  if (range && request.headers.has("range")) {
    const { offset, length } = resolveRange(range, object.size);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  // Content-Type and friends as uploaded. No default Content-Type is invented:
  // a generic `application/octet-stream` on `bundle.tar.gz` would trip Cache
  // Deception Armor (extension and type disagree) and bypass the cache.
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("accept-ranges", "bytes");
  // An uploader's own Cache-Control (e.g. `immutable` on a versioned key)
  // wins; everything else gets the default edge lifetime.
  if (!object.httpMetadata?.cacheControl) {
    headers.set("cache-control", DEFAULT_EDGE_CACHE_CONTROL);
  }
  return headers;
}

/** R2 reports a range in any of three shapes; turn it into offset + length. */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } {
  if ("suffix" in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = "offset" in range && range.offset !== undefined ? range.offset : 0;
  const length = "length" in range && range.length !== undefined ? range.length : size - offset;
  return { offset, length };
}

/** The R2 key a URL names: its path without the leading slash, percent-decoded. */
export function objectKey(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    // A malformed escape names no object we could have stored.
    return "";
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export type Verdict = "allowed" | "denied" | "unavailable";

/**
 * Ask the API whether `token` is live, remembering a yes for
 * {@link AUTH_CACHE_SECONDS}.
 */
export async function authenticate(
  token: string,
  env: Pick<Env, "API">,
  ctx: Pick<ExecutionContext, "waitUntil">,
  cache: Cache = caches.default,
): Promise<Verdict> {
  // Keyed by a hash so the credential itself is never a cache key. The host is
  // ours and the path unrouted, so it cannot collide with a real response.
  const cacheKey = new Request(
    `https://instances-bundles.infrawrench.com/__auth/${await sha256Hex(token)}`,
  );
  if (await cache.match(cacheKey)) return "allowed";

  let response: Response;
  try {
    response = await env.API.fetch(`${API_ORIGIN}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return "unavailable";
  }
  // Drain the body either way so the subrequest is released.
  await response.body?.cancel();

  if (response.status === 401 || response.status === 403) return "denied";
  // Anything else that is not a yes says nothing about the credential; refusing
  // as if it were bad would read as "your key is revoked" during an outage.
  if (!response.ok) return "unavailable";

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(null, { headers: { "cache-control": `max-age=${AUTH_CACHE_SECONDS}` } }),
    ),
  );
  return "allowed";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function notFound(): Response {
  return text(404, "Not found", { "cache-control": NOT_FOUND_CACHE_CONTROL });
}

export function unauthorized(): Response {
  return text(401, "Unauthorized", {
    "www-authenticate": 'Bearer realm="instances-bundles"',
  });
}

export function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/**
 * status-page-edge — vanity-host origin for public status pages.
 *
 * Cloudflare for SaaS terminates TLS on the customer's hostname and routes
 * here (Worker as origin). We look up Host → slug in Workers KV (written by
 * the cloud API when a custom domain is attached), then proxy to the real app:
 *
 * - `GET /api/status` (and `/api/status/*`) → `ORIGIN/api/status/{slug}`
 * - static assets → `ORIGIN` unchanged
 * - everything else → SPA shell from `ORIGIN/` so the client can detect a
 *   non-app host and render only the public status view
 *
 * Hostname→slug lives in KV on purpose: the app must never trust a raw Host
 * header for public lookup (spoofing on app.infrawrench.com).
 */

export interface Env {
  STATUS_HOSTS: KVNamespace;
  /** App origin that serves the SPA + `/api/status/:slug`, no trailing slash. */
  ORIGIN: string;
}

function normalizeHost(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0]?.trim().toLowerCase() ?? "";
  if (!host) return null;
  return host;
}

function isAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/@") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/src/") ||
    /\.[a-z0-9]+$/i.test(pathname)
  );
}

async function proxy(origin: string, pathAndQuery: string, request: Request): Promise<Response> {
  const url = `${origin.replace(/\/+$/, "")}${pathAndQuery}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("content-length");

  return fetch(url, {
    method: request.method,
    headers,
    redirect: "manual",
    // Document and API reads are GET/HEAD only in practice; reject bodies
    // rather than stream them through.
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = normalizeHost(request.headers.get("host"));
    if (!host) return new Response("Not found", { status: 404 });

    const slug = await env.STATUS_HOSTS.get(host);
    if (!slug) return new Response("Not found", { status: 404 });

    const url = new URL(request.url);
    const { pathname, search } = url;

    if (pathname === "/api/status" || pathname.startsWith("/api/status/")) {
      return proxy(env.ORIGIN, `/api/status/${encodeURIComponent(slug)}${search}`, request);
    }

    if (isAssetPath(pathname)) {
      return proxy(env.ORIGIN, `${pathname}${search}`, request);
    }

    // Document requests: serve the SPA shell. The client sees this host as a
    // custom status domain and fetches `/api/status` (handled above).
    if (request.method === "GET" || request.method === "HEAD") {
      return proxy(env.ORIGIN, `/${search}`, request);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

export { normalizeHost, isAssetPath };

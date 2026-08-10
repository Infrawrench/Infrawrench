/**
 * Baseline security response headers, applied to every response this server
 * emits — API JSON, the SPA shell, static assets, MCP, and `/healthz`.
 *
 * The header set is defined once, in {@link securityHeaderEntries}, and applied
 * through two thin adapters because responses leave this server by two
 * different routes:
 *
 *   - {@link securityHeaders} — Hono middleware, mounted on `api` (the API
 *     surface in dev and prod) and on the prod-only `prodApp` that also serves
 *     `dist/client`. Both, because `prodApp` emits the SPA shell and static
 *     assets that `api` never sees, and the framing defence matters most on
 *     exactly that HTML document. Setting identical values twice is a no-op.
 *   - {@link applySecurityHeaders} — for the two handlers that write to a raw
 *     `node:http` `ServerResponse` and never touch Hono at all: `/api/mcp`
 *     (`mcp/http-handler.ts`) and `/healthz`. `server.ts` intercepts both paths
 *     at the Node HTTP level *before* the Hono listener, so middleware cannot
 *     reach them; they call this directly instead.
 *
 * One record and two adapters rather than two lists: a header set that is
 * maintained in two places is a header set that will disagree in one of them.
 *
 * What is deliberately NOT here
 * -----------------------------
 * There is no `default-src`/`script-src` CSP. The clickjacking defence that
 * motivated this module is `frame-ancestors`, which is included and is inert
 * with respect to what the page may load. A script CSP is a genuinely separate
 * piece of work, because three things in this app load or generate script from
 * outside the bundle:
 *
 *   - `@monaco-editor/react` fetches the Monaco AMD loader from jsdelivr unless
 *     it is explicitly configured with a bundled `monaco` instance, and Monaco
 *     spawns its language workers from `blob:` URLs.
 *   - The `/docs` page loads the Scalar standalone bundle from jsdelivr
 *     (`SCALAR_VERSION` in `api/index.ts`).
 *   - Vite's dev server serves inline module scripts and uses `eval` for HMR.
 *
 * A `script-src` that covers those honestly needs nonce plumbing through
 * `index.html`, pinning Monaco to the bundle, and a route-specific relaxation
 * for `/docs` — then testing against the editor, the terminal, and the docs
 * page. Shipping `'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net` in
 * the meantime would read as a CSP while permitting exactly the injection a CSP
 * exists to stop, so this module states the gap instead of pretending to close
 * it.
 *
 * COOP/CORP/COEP are also absent, and also deliberately. They would sever
 * `window.opener` and cross-origin resource reads; the browser app needs
 * neither, but the OAuth round trips (WorkOS sign-in, "Add to Slack", the
 * GitHub App setup callback) are full-page redirects whose behaviour under COOP
 * is worth verifying against a real WorkOS tenant first, and neither header
 * closes a gap found here.
 */
import { createMiddleware } from "hono/factory";
import type { ServerResponse } from "node:http";

/**
 * HSTS is production-only. On `http://localhost:3000` browsers ignore the
 * header over plain HTTP anyway, but a developer who once reaches the dev
 * server through a local HTTPS proxy would pin `localhost` to HTTPS for two
 * years — across every project on that machine, not just this one.
 */
function buildHeaders(): ReadonlyArray<readonly [string, string]> {
  const headers: Array<readonly [string, string]> = [
    // The clickjacking fix. `frame-ancestors` is what modern browsers honour;
    // `X-Frame-Options` covers anything that predates it. This app drives SSH
    // terminals and resource deletion from a session cookie, so being framed at
    // all is the risk.
    ["content-security-policy", "frame-ancestors 'none'"],
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    // Origin cross-site, full path same-origin. Resource and org ids live in
    // our paths and should not ride along to a third party in a `Referer`, but
    // stripping the header entirely breaks flows that legitimately check it.
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["x-dns-prefetch-control", "off"],
    ["x-permitted-cross-domain-policies", "none"],
  ];
  if (process.env["NODE_ENV"] === "production") {
    headers.push(["strict-transport-security", "max-age=63072000; includeSubDomains; preload"]);
  }
  return headers;
}

/**
 * Resolved once on first use rather than at import time: `NODE_ENV` is stable
 * for the life of the process, but module import order versus env loading is
 * not something this module should have to depend on.
 */
let cached: ReadonlyArray<readonly [string, string]> | null = null;

/** The header set, as lowercase name/value pairs. */
export function securityHeaderEntries(): ReadonlyArray<readonly [string, string]> {
  cached ??= buildHeaders();
  return cached;
}

/** Test seam: forget the memoized set so a test can vary `NODE_ENV`. */
export function resetSecurityHeadersCache(): void {
  cached = null;
}

/**
 * Apply the headers to a raw `node:http` response. For handlers that bypass
 * Hono entirely — see the module docstring. Safe to call more than once, and
 * must be called before the first `write`/`end`, like any header write.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of securityHeaderEntries()) res.setHeader(name, value);
}

/** Hono middleware form, for every response that does go through Hono. */
export const securityHeaders = () =>
  createMiddleware(async (c, next) => {
    await next();
    for (const [name, value] of securityHeaderEntries()) c.header(name, value);
  });

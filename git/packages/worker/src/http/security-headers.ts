/**
 * The response headers every answer from this Worker carries, whatever
 * produced it: the API, the sign-in routes, the SPA shell and its assets,
 * and (once they exist) the Git transports.
 *
 * One function, applied once at the entry (`./router.ts`), so a new route
 * cannot forget them. A response that already set one of these keeps its own:
 * the raw file route answers `Content-Security-Policy: sandbox`, which must
 * not be loosened to the page's policy.
 */
import type { Env } from "../env";

/** The origin sign-out's form posts on to, after `/auth/sign-out` redirects there. */
const workosOrigin = (env: Pick<Env, "WORKOS_API_HOSTNAME">): string =>
  `https://${env.WORKOS_API_HOSTNAME ?? "api.workos.com"}`;

/**
 * The page's policy: scripts, styles, fonts and requests from this origin
 * only. The UI is a built bundle with no inline script; styles allow inline
 * because the component library sets `style` attributes. Images load from
 * this origin only: one from another site comes through the image proxy
 * (`images/proxy.ts`), so its host never sees the reader, and one the UI
 * forgot to route there does not load. Nothing may frame the site.
 */
export const pageContentSecurityPolicy = (env: Pick<Env, "WORKOS_API_HOSTNAME">): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self' ${workosOrigin(env)}`,
    "frame-ancestors 'none'",
  ].join("; ");

/** What a response that is data, not a page, may do if a browser renders it: nothing. */
export const DATA_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

const isPage = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");

/** `response` with the headers set. Never throws on an immutable response: it is copied. */
export const withSecurityHeaders = (
  response: Response,
  request: { readonly url: string },
  env: Pick<Env, "WORKOS_API_HOSTNAME">,
  requestId: string,
): Response => {
  // A WebSocket upgrade's response cannot be rebuilt, and has no body to protect.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  const setDefault = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  setDefault(
    "content-security-policy",
    isPage(response) ? pageContentSecurityPolicy(env) : DATA_CONTENT_SECURITY_POLICY,
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  setDefault("referrer-policy", "strict-origin-when-cross-origin");
  setDefault("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // A window this site opens, or that opens it, gets no handle on the other.
  setDefault("cross-origin-opener-policy", "same-origin");
  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  }
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * This request's id: Cloudflare's ray id when there is one, so an answer, a
 * log line and the dashboard's trace all name the same thing.
 */
export const requestIdOf = (request: { readonly headers: { get(name: string): string | null } }) =>
  request.headers.get("cf-ray") ?? crypto.randomUUID();

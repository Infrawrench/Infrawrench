/**
 * The GETs `index.html` starts before the bundle has loaded.
 *
 * The shell cannot render until `/api/auth/me` has answered (and, on `/`,
 * `/api/auth/orgs` after it), and none of that started until the entry chunk
 * had downloaded, gt-react had settled the locale and the app chunk had run.
 * An inline script in `index.html` sends those requests with the page instead,
 * so they overlap the bundle download; a cold edge isolate spends a second or
 * more loading the API before it answers the first one, which this hides too.
 *
 * The script keeps `/api/auth/me` first and alone. Each request may refresh
 * an expired WorkOS session, and concurrent refreshes of one session race, so
 * the others (`/api/auth/orgs`, and `/api/org/:orgId/team/me` on an org page)
 * start only once it has answered, the order the app itself keeps.
 *
 * {@link takeBootResponse} hands each response to the first `apiFetch` GET of
 * the same path, which then treats it exactly like one it sent (the 401
 * redirect included). Each is taken once, and only while fresh, so nothing
 * later is answered from boot.
 */

interface BootRequests {
  /** `Date.now()` when the script ran. */
  readonly at: number;
  /** Pending responses by request path, removed as they are taken. */
  readonly responses: Record<string, Promise<Response> | undefined>;
}

declare global {
  interface Window {
    __IW_BOOT__?: BootRequests;
  }
}

/** Past this, a boot response is too old to stand in for a fresh request. */
const MAX_AGE_MS = 20_000;

/**
 * The response `index.html` started for a plain GET of `path`, or undefined
 * (any other method, a body, extra headers, already taken, or stale).
 */
export function takeBootResponse(path: string, init?: RequestInit): Promise<Response> | undefined {
  if (init && (init.method !== undefined || init.body !== undefined || init.headers)) {
    return undefined;
  }
  const boot = typeof window === "undefined" ? undefined : window.__IW_BOOT__;
  const pending = boot?.responses[path];
  if (!boot || !pending) return undefined;
  delete boot.responses[path];
  return Date.now() - boot.at <= MAX_AGE_MS ? pending : undefined;
}

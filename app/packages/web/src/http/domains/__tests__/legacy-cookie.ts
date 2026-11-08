/**
 * A `Set-Cookie` value exactly as the API wrote its cookies while it ran on
 * Hono (`generateCookie` from `hono/cookie`, for the options the routes
 * used). The domains keep that wire format byte for byte; this freezes it
 * here so the tests can pin it without the framework.
 */
export interface LegacyCookieOptions {
  readonly path?: string;
  /** Seconds; truncated to an integer, as Hono did. */
  readonly maxAge?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "lax" | "Lax" | "strict" | "Strict" | "none" | "None";
}

export function legacyCookie(name: string, value: string, options: LegacyCookieOptions = {}) {
  const { path = "/", maxAge, httpOnly, secure, sameSite } = options;
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (maxAge !== undefined && maxAge >= 0) cookie += `; Max-Age=${Math.trunc(maxAge)}`;
  if (path) cookie += `; Path=${path}`;
  if (httpOnly) cookie += "; HttpOnly";
  if (secure) cookie += "; Secure";
  if (sameSite) cookie += `; SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`;
  return cookie;
}

/** Cookie name used to round-trip the OAuth `state` nonce through WorkOS. */
export const OAUTH_STATE_COOKIE = "iw_oauth_state";

/**
 * Cookie carrying where to land after a successful sign-in. Kept in a cookie
 * rather than the OAuth `state` parameter so `state` stays a pure CSRF nonce
 * that the callback can compare byte-for-byte.
 */
export const RETURN_TO_COOKIE = "iw_return_to";

/**
 * Normalize a caller-supplied post-sign-in destination to a safe same-origin
 * path, or null if it isn't one.
 *
 * Rejects anything that could leave the origin: absolute URLs, scheme-relative
 * `//evil.com` (which browsers resolve as a host, not a path), and backslash
 * variants that some parsers fold to `/`. The result always starts with a
 * single `/`, so it can only ever be a path on this site.
 */
export function safeReturnPath(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.length > 512) return null;
  // Must be root-relative, and must not be protocol-relative.
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // No control characters (header/redirect splitting) anywhere in the value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

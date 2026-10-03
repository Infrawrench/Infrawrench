/**
 * Deep links back into the web app, for notification buttons and message
 * bodies. Every one is rooted at `APP_URL`; a deployment that never set it
 * gets null rather than a relative or guessed link, and each caller drops the
 * button.
 *
 * `APP_URL` is read per call rather than once at import, so a test (or a
 * process that sets it late) sees the current value.
 */

/** `APP_URL` without a trailing slash, or null when the server has none configured. */
export function appBaseUrl(): string | null {
  const base = process.env["APP_URL"];
  return base ? base.replace(/\/$/, "") : null;
}

/** `APP_URL`-rooted deep link for `path` (which starts with `/`), or null without `APP_URL`. */
export function appPath(path: string): string | null {
  const base = appBaseUrl();
  return base === null ? null : `${base}${path}`;
}

/**
 * Deep link to a page inside an organization: `orgAppUrl(id, "costs")` is
 * `${APP_URL}/org/${id}/costs`. Null without `APP_URL`.
 */
export function orgAppUrl(organizationId: string, page: string): string | null {
  return appPath(`/org/${organizationId}/${page}`);
}

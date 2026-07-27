/**
 * Deciding whether a sync failure is worth retrying.
 *
 * These two predicates gate the account's backoff, so a false positive is
 * expensive: a permanent error misread as transient pins an otherwise healthy
 * account at maximum backoff indefinitely, failure count climbing, with no
 * error text stored anywhere to explain it.
 *
 * Kept free of database and plugin imports so they can be tested directly.
 */

/**
 * HTTP status a plugin attached to the error, when it did.
 *
 * Always preferred over digging digits out of the message. A bare `/5\d\d/`
 * over the text matches any three digits that happen to sit in a project id,
 * resource name or timestamp — a GCP project called `acme-atom-503516-h4`
 * reads as a 503, so its permanent 403s classified as transient and pinned the
 * account at maximum backoff forever while resources kept syncing fine. The
 * word boundaries below stop that specific shape; a real status stops the
 * whole class.
 */
function httpStatusOf(err: Error): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown };
  const raw = typeof e.status === "number" ? e.status : e.statusCode;
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

export function isRateLimitError(err: Error): boolean {
  const status = httpStatusOf(err);
  if (status === 429) return true;
  const msg = err.message.toLowerCase();
  // Wording counts even when a status is present: some providers signal
  // throttling with a 403 plus a reason string rather than a 429 (GCP's
  // rateLimitExceeded / userRateLimitExceeded are the common ones).
  if (
    msg.includes("rate limit") ||
    msg.includes("ratelimitexceeded") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  ) {
    return true;
  }
  // Only guess from digits when the plugin gave us no status to trust.
  return status === undefined && /\b429\b/.test(msg);
}

export function isTransientError(err: Error): boolean {
  if (isRateLimitError(err)) return true;
  const status = httpStatusOf(err);
  if (status !== undefined) return status >= 500;
  const msg = err.message.toLowerCase();
  return /\b5\d\d\b/.test(msg) || msg.includes("timeout") || msg.includes("econnreset");
}

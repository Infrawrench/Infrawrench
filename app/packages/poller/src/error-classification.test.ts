import { describe, expect, it } from "vitest";

// These predicates decide whether a sync failure backs the account off, so the
// cost of a false positive is high: a permanent error misread as transient
// pins an otherwise healthy account at maximum backoff indefinitely.
import { isRateLimitError, isTransientError } from "./error-classification";

/** Attach an HTTP status the way the GCP plugin's `gcpApiError` does. */
function withStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Verbatim from a real GCP account. Both the project id (`…-503516-h4`) and
 * the project number (`205336108475`) contain runs that a naive /5\d\d/ reads
 * as a 5xx status — this exact string is what put the account into permanent
 * backoff.
 */
const DISABLED_API =
  "The Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled for project " +
  "consummate-atom-503516-h4. Enable it at " +
  "https://console.cloud.google.com/apis/library/sqladmin.googleapis.com" +
  "?project=consummate-atom-503516-h4 — it can take a few minutes to take effect.";

const RAW_403 =
  "GCP API 403 for https://sqladmin.googleapis.com/v1/projects/consummate-atom-503516-h4/instances: " +
  '{"error":{"code":403,"message":"Cloud SQL Admin API has not been used in project 205336108475 ' +
  'before or it is disabled.","status":"PERMISSION_DENIED"}}';

describe("isTransientError", () => {
  it("does not treat a disabled-API 403 as transient", () => {
    expect(isTransientError(withStatus(DISABLED_API, 403))).toBe(false);
    expect(isTransientError(withStatus(RAW_403, 403))).toBe(false);
  });

  it("ignores digits inside project ids when no status is attached", () => {
    // Same messages, but from a plugin that attaches no status — the word
    // boundaries have to carry it alone.
    expect(isTransientError(new Error(DISABLED_API))).toBe(false);
    expect(isTransientError(new Error(RAW_403))).toBe(false);
  });

  it("still catches real 5xx responses", () => {
    expect(isTransientError(withStatus("GCP API 503 for https://x: unavailable", 503))).toBe(true);
    expect(isTransientError(new Error("GCP API 503 for https://x: unavailable"))).toBe(true);
    expect(isTransientError(new Error("Upstream returned 500"))).toBe(true);
  });

  it("still catches network-level failures", () => {
    expect(isTransientError(new Error("socket timeout after 30s"))).toBe(true);
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("trusts an attached status over digits in the text", () => {
    // A 404 whose body happens to mention 500-something must not back off.
    expect(isTransientError(withStatus("no such instance: db-500-a", 404))).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("catches a 429 by status or by wording", () => {
    expect(isRateLimitError(withStatus("slow down", 429))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("Quota exceeded for quota metric"))).toBe(true);
  });

  it("catches providers that throttle with a 403 plus a reason", () => {
    // GCP's userRateLimitExceeded is a 403, not a 429.
    expect(isRateLimitError(withStatus("rateLimitExceeded: too fast", 403))).toBe(true);
  });

  it("does not fire on a 429 that is only part of an identifier", () => {
    expect(isRateLimitError(withStatus("instance i-4290abc not found", 404))).toBe(false);
    expect(isRateLimitError(new Error("instance i-4290abc not found"))).toBe(false);
  });

  it("does not classify a disabled API as throttling", () => {
    expect(isRateLimitError(withStatus(DISABLED_API, 403))).toBe(false);
  });
});

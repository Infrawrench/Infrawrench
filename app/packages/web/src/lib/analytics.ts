import { initAnalytics } from "@infrawrench/analytics";

/**
 * Path segments that are themselves a secret: share and invite links, and the
 * inbound webhook URLs whose token is the only credential.
 */
const TOKEN_SEGMENT =
  /\/(share|invite|invites|by-token|paging-webhooks|issue-webhooks\/(?:jira|linear)|workflows\/git)\/[^/?#]+/g;

/**
 * What a URL looks like by the time it reaches PostHog, on events and in
 * replays. The query string and fragment go entirely: the SPA keeps its state
 * in path segments, and what does land in a query here is an OAuth `code`, a
 * claim code or similar.
 */
export function redactAppUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(TOKEN_SEGMENT, "/$1/[redacted]");
}

export function startAnalytics(): void {
  // Public status pages are read by an org's own customers, who never signed
  // up for anything here.
  if (window.location.pathname.startsWith("/status/")) return;
  initAnalytics({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
    sensitive: true,
    redactUrl: redactAppUrl,
  });
}

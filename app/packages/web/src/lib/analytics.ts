import {
  bindRevnuToAnalyticsConsent,
  holdRevnuWithoutAnalytics,
  initAnalytics,
  type RevnuConsentSnapshot,
} from "@infrawrench/analytics";

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

/** Org settings path that can refresh an unpaid checkout after consent changes. */
export function revnuConsentRefreshPath(pathname: string): string | null {
  const match = /^\/org\/([^/]+)(?:\/|$)/.exec(pathname);
  const orgId = match?.[1];
  if (!orgId) return null;
  return `/api/org/${encodeURIComponent(orgId)}/billing/measurement-consent`;
}

function refreshUnreportedRevnuConsent(snapshot: RevnuConsentSnapshot): void {
  const path = revnuConsentRefreshPath(window.location.pathname);
  if (!path || !snapshot.anonymousId) return;
  // Raw fetch: apiPost redirects the browser to sign-in on 401, and this runs
  // on pages where the visitor may be signed out. 403 is a member who cannot
  // buy; there is no checkout of theirs to update.
  void fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      measurement: {
        anonymousId: snapshot.anonymousId,
        consentState: snapshot.consentState,
        googleAdUserData: snapshot.googleAdUserData,
        googleAdPersonalization: snapshot.googleAdPersonalization,
      },
    }),
  }).catch(() => undefined);
}

export function startAnalytics(): void {
  // Public status pages are read by an org's own customers, who never signed
  // up for anything here. The tag is on the document, so hold it pending.
  if (window.location.pathname.startsWith("/status/")) {
    holdRevnuWithoutAnalytics();
    return;
  }
  initAnalytics({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
    sensitive: true,
    redactUrl: redactAppUrl,
  });
  bindRevnuToAnalyticsConsent({ onChange: refreshUnreportedRevnuConsent });
}

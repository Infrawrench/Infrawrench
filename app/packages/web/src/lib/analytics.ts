import {
  bindRevnuToAnalyticsConsent,
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

/**
 * Paths the Revnu tag must not run on, because it sends the current path to a
 * third party: public status pages, read by an org's own customers who never
 * signed up for anything here, and any path whose segment is itself a secret.
 */
export function revnuHeldPath(pathname: string): boolean {
  return pathname.startsWith("/status/") || redactAppUrl(pathname) !== pathname;
}

/** Org settings path that can refresh an unpaid checkout after consent changes. */
export function revnuConsentRefreshPath(pathname: string): string | null {
  const match = /^\/org\/([^/]+)(?:\/|$)/.exec(pathname);
  const orgId = match?.[1];
  if (!orgId) return null;
  return `/api/org/${encodeURIComponent(orgId)}/billing/measurement-consent`;
}

const CONSENT_SYNC_KEY = "infrawrench-measurement-consent:";

function readSyncedConsent(path: string): string | null {
  try {
    return window.localStorage.getItem(CONSENT_SYNC_KEY + path);
  } catch {
    return null;
  }
}

function writeSyncedConsent(path: string, consent: string): void {
  try {
    window.localStorage.setItem(CONSENT_SYNC_KEY + path, consent);
  } catch {
    // Without storage the answer is sent again next load, which is harmless.
  }
}

/**
 * Send a consent answer to the server once per answer and org, whichever page or
 * subdomain it was given on: the next load inside the org picks up a decline
 * made on the marketing site or during onboarding. Pending is not an answer, and
 * PostHog passes through it on the way to an automatic opt-in.
 */
function refreshUnreportedRevnuConsent(snapshot: RevnuConsentSnapshot): void {
  const path = revnuConsentRefreshPath(window.location.pathname);
  if (!path || snapshot.consentState === "pending") return;
  if (readSyncedConsent(path) === snapshot.consentState) return;
  const { consentState } = snapshot;
  // Raw fetch: apiPost redirects the browser to sign-in on 401, and this runs
  // on pages where the visitor may be signed out. 403 is a member who cannot
  // buy; there is no checkout of theirs to update.
  void fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      measurement: {
        consentState,
        ...(snapshot.anonymousId ? { anonymousId: snapshot.anonymousId } : {}),
      },
    }),
  })
    .then((response) => {
      if (response.ok || response.status === 403) writeSyncedConsent(path, consentState);
    })
    .catch(() => undefined);
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
  bindRevnuToAnalyticsConsent({
    holdPath: revnuHeldPath,
    onChange: refreshUnreportedRevnuConsent,
  });
}

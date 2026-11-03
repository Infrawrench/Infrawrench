/**
 * Join the marketing site and the app to one Revnu visitor.
 *
 * The tag's own cookies are host-only. After analytics consent is granted we
 * copy `revnu_aid` onto `.infrawrench.com` so the app tag adopts the same id.
 * Pending must not delete that cookie: PostHog can pass through pending before
 * an automatic opt-in, and deleting it would mint a new visitor. Denial does
 * delete it. Google ad choices are not collected here, so they stay unknown.
 */

export const REVNU_ANONYMOUS_ID = /^ra_[0-9a-f]{32}$/;

export type RevnuConsent = "granted" | "denied" | "pending";

export const REVNU_GOOGLE_CONSENT = {
  adUserData: "unknown",
  adPersonalization: "unknown",
} as const;

export interface RevnuBrowser {
  anonymousId?: string;
  getContext?: () => { anonymousId?: string | null };
  consent?: (state: RevnuConsent) => void;
  googleConsent?: (choice: {
    adUserData: "granted" | "denied" | "unknown";
    adPersonalization: "granted" | "denied" | "unknown";
  }) => void;
}

declare global {
  interface Window {
    revnu?: RevnuBrowser;
  }
}

export function revnuConsentForAnalytics(
  state: "granted" | "denied" | "pending" | "inactive",
): RevnuConsent {
  if (state === "inactive") return "granted";
  return state;
}

export function revnuAnonymousId(value: unknown): string | null {
  return typeof value === "string" && REVNU_ANONYMOUS_ID.test(value) ? value : null;
}

/** A `document.cookie` assignment, or null when this page should not write one. */
export function revnuParentCookie(
  consent: RevnuConsent,
  anonymousId: string | null,
  host: string,
  protocol: string,
): string | null {
  if (protocol !== "https:") return null;
  if (host !== "infrawrench.com" && !host.endsWith(".infrawrench.com")) return null;
  if (consent === "pending") return null;
  if (consent === "denied") {
    return "revnu_aid=; Domain=.infrawrench.com; Path=/; Max-Age=0; SameSite=Lax; Secure";
  }
  const id = revnuAnonymousId(anonymousId);
  if (!id) return null;
  return `revnu_aid=${encodeURIComponent(id)}; Domain=.infrawrench.com; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

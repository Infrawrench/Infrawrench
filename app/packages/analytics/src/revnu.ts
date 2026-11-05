/**
 * Join the marketing site and the app to one Revnu visitor.
 *
 * The tag is only ever loaded after analytics consent is granted (see
 * `bindRevnuToAnalyticsConsent`), so a visitor who has not answered makes no
 * request to revnu.com. Its own cookies are host-only, so after a grant we copy
 * `revnu_aid` onto `.infrawrench.com` for the app tag to adopt. Pending must not
 * delete that cookie: PostHog can pass through pending before an automatic
 * opt-in, and deleting it would mint a new visitor. Denial does delete it.
 */

export const REVNU_ANONYMOUS_ID = /^ra_[0-9a-f]{32}$/;

export const REVNU_TAG_SRC = "https://revnu.com/v1.js";
export const REVNU_TAG_SITE = "rk_3f75e7bd28424c9e9623b127622900bd";
export const REVNU_TAG_ENDPOINT = "https://revnu.com/api/measurement/collect";

export type RevnuConsent = "granted" | "denied" | "pending";

export interface RevnuBrowser {
  anonymousId?: string;
  getContext?: () => { anonymousId?: string | null };
  consent?: (state: RevnuConsent) => void;
}

declare global {
  interface Window {
    revnu?: RevnuBrowser;
  }
}

/** Without a consent manager nobody has been asked, which is not a yes. */
export function revnuConsentForAnalytics(
  state: "granted" | "denied" | "pending" | "inactive",
): RevnuConsent {
  return state === "inactive" ? "pending" : state;
}

export function revnuAnonymousId(value: unknown): string | null {
  return typeof value === "string" && REVNU_ANONYMOUS_ID.test(value) ? value : null;
}

/** Local development, preview and self-hosted builds must not report to the production site. */
export function revnuTagAllowed(host: string, protocol: string): boolean {
  return protocol === "https:" && (host === "infrawrench.com" || host.endsWith(".infrawrench.com"));
}

/** The visitor id in a `document.cookie` string. */
export function revnuIdFromCookies(cookies: string): string | null {
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name !== "revnu_aid" || !value) continue;
    try {
      const id = revnuAnonymousId(decodeURIComponent(value));
      if (id) return id;
    } catch {
      // A malformed cookie is not a visitor id.
    }
  }
  return null;
}

/** A `document.cookie` assignment, or null when this page should not write one. */
export function revnuParentCookie(
  consent: RevnuConsent,
  anonymousId: string | null,
  host: string,
  protocol: string,
): string | null {
  if (!revnuTagAllowed(host, protocol)) return null;
  if (consent === "pending") return null;
  if (consent === "denied") {
    return "revnu_aid=; Domain=.infrawrench.com; Path=/; Max-Age=0; SameSite=Lax; Secure";
  }
  const id = revnuAnonymousId(anonymousId);
  if (!id) return null;
  return `revnu_aid=${encodeURIComponent(id)}; Domain=.infrawrench.com; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

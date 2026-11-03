/**
 * Read the Revnu visitor id and the consent saved for this page, at the moment
 * checkout starts. Absent or malformed values are omitted. Google choices stay
 * unknown unless the tag itself reports one. This never calls confirm().
 */

const ANONYMOUS_ID = /^ra_[0-9a-f]{32}$/;

export interface RevnuMeasurement {
  anonymousId?: string;
  consentState?: "granted" | "denied" | "pending";
  googleAdUserData?: "granted" | "denied" | "unknown";
  googleAdPersonalization?: "granted" | "denied" | "unknown";
}

interface RevnuContext {
  anonymousId?: string | null;
  consentState?: string | null;
  googleAdUserData?: string | null;
  googleAdPersonalization?: string | null;
}

interface RevnuTag {
  anonymousId?: string;
  getContext?: () => RevnuContext;
}

export function readRevnuMeasurement(): RevnuMeasurement | undefined {
  const browser = (globalThis as { window?: Window & { revnu?: RevnuTag } }).window;
  if (!browser) return undefined;
  const revnu = browser.revnu;
  if (!revnu) return undefined;
  let context: RevnuContext = {};
  try {
    context = revnu.getContext?.() ?? {};
  } catch {
    context = {};
  }
  const measurement: RevnuMeasurement = {};
  const anonymousId =
    typeof context.anonymousId === "string" ? context.anonymousId : revnu.anonymousId;
  if (typeof anonymousId === "string" && ANONYMOUS_ID.test(anonymousId)) {
    measurement.anonymousId = anonymousId;
  }
  if (
    context.consentState === "granted" ||
    context.consentState === "denied" ||
    context.consentState === "pending"
  ) {
    measurement.consentState = context.consentState;
  }
  if (
    context.googleAdUserData === "granted" ||
    context.googleAdUserData === "denied" ||
    context.googleAdUserData === "unknown"
  ) {
    measurement.googleAdUserData = context.googleAdUserData;
  }
  if (
    context.googleAdPersonalization === "granted" ||
    context.googleAdPersonalization === "denied" ||
    context.googleAdPersonalization === "unknown"
  ) {
    measurement.googleAdPersonalization = context.googleAdPersonalization;
  }
  if (
    !measurement.anonymousId &&
    !measurement.consentState &&
    !measurement.googleAdUserData &&
    !measurement.googleAdPersonalization
  ) {
    return undefined;
  }
  return measurement;
}

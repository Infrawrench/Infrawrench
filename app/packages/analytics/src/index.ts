import posthog, { type CaptureResult, type Properties } from "posthog-js";
import { visitorNeedsConsent } from "./region";

export { countryNeedsConsent, parseTraceCountry } from "./region";

/**
 * PostHog for the browser surfaces (web app, website, instances site): product
 * analytics, web analytics and session replay, behind one consent model.
 *
 * Every surface uses the same project key, and the consent answer is a cookie
 * on the registrable domain, so a visitor who answers on infrawrench.com is not
 * asked again on app.infrawrench.com. Until they answer PostHog runs in its
 * `on_reject` cookieless mode, which stores nothing and sends nothing; visitors
 * outside the EEA, UK and Switzerland are opted in without a prompt (see
 * `region.ts`), and anyone can change their answer with `openConsentPrompt`.
 */
export interface AnalyticsOptions {
  /** PostHog project API key (`phc_…`). Without one, everything here is a no-op. */
  key: string | undefined;
  /** Ingestion host. Defaults to PostHog US Cloud. */
  host?: string | undefined;
  /**
   * For surfaces that render customer data (the web app): masks every text
   * node in session replays, drops element text and attributes from
   * autocapture, and records no network request headers or bodies.
   */
  sensitive?: boolean;
  /**
   * Rewrites a URL before it leaves the browser, on events and in replays.
   * For paths that carry a secret, such as share and invite tokens.
   */
  redactUrl?: (url: string) => string;
}

let enabled = false;
let promptVisible = false;
const promptListeners = new Set<() => void>();
let identity: { id: string; properties: Properties } | null = null;
let organization: string | null = null;
let appliedOrganization: string | null = null;

function setPrompt(visible: boolean): void {
  if (promptVisible === visible) return;
  promptVisible = visible;
  for (const listener of promptListeners) listener();
}

/** Event properties holding a URL or path; `$set_once` carries the initial ones. */
function isUrlProperty(key: string): boolean {
  return /(url|referrer|pathname)$/i.test(key);
}

function redactProperties(properties: Properties | undefined, redact: (url: string) => string) {
  if (!properties) return;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string" && isUrlProperty(key)) properties[key] = redact(value);
  }
}

function redactEvent(event: CaptureResult, redact: (url: string) => string): CaptureResult {
  redactProperties(event.properties, redact);
  redactProperties(event.$set, redact);
  redactProperties(event.$set_once, redact);
  return event;
}

function consentGranted(): boolean {
  return enabled && posthog.get_explicit_consent_status() === "granted";
}

/**
 * Identity only ever goes out after consent: in cookieless mode PostHog would
 * attach it to a hashed, storage-free visitor, which is what that mode exists
 * to avoid. `opt_in_capturing` also resets the instance, so this runs after it.
 */
function applyIdentity(): void {
  if (!consentGranted()) return;
  if (identity && posthog.get_distinct_id() !== identity.id) {
    posthog.identify(identity.id, identity.properties);
  }
  if (organization && organization !== appliedOrganization) {
    posthog.group("organization", organization);
    appliedOrganization = organization;
  }
}

async function settleConsent(): Promise<void> {
  if (posthog.get_explicit_consent_status() !== "pending") {
    applyIdentity();
    return;
  }
  if (await visitorNeedsConsent()) {
    setPrompt(true);
    return;
  }
  posthog.opt_in_capturing({ captureEventName: false });
  applyIdentity();
}

/** Starts PostHog once per page. Safe to call during SSR, where it does nothing. */
export function initAnalytics(options: AnalyticsOptions): void {
  if (enabled || !options.key || typeof window === "undefined") return;
  enabled = true;
  const { redactUrl, sensitive = false } = options;

  posthog.init(options.key, {
    api_host: options.host || "https://us.i.posthog.com",
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    cookieless_mode: "on_reject",
    opt_out_capturing_persistence_type: "cookie",
    cross_subdomain_cookie: true,
    // Do Not Track and Global Privacy Control read as a refusal.
    respect_dnt: true,
    mask_all_text: sensitive,
    mask_all_element_attributes: sensitive,
    session_recording: {
      maskAllInputs: true,
      ...(sensitive ? { maskTextSelector: "*", recordHeaders: false, recordBody: false } : {}),
      // Also runs against the page URL the replay player shows.
      ...(redactUrl
        ? {
            maskCapturedNetworkRequestFn: (request) => ({
              ...request,
              name: redactUrl(request.name),
            }),
          }
        : {}),
    },
    ...(redactUrl
      ? { before_send: (event) => (event ? redactEvent(event, redactUrl) : event) }
      : {}),
  });

  void settleConsent();
}

/** True once `initAnalytics` has run with a key; surfaces hide the preferences link otherwise. */
export function analyticsEnabled(): boolean {
  return enabled;
}

export function subscribeConsentPrompt(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

export function consentPromptVisible(): boolean {
  return promptVisible;
}

/** Re-asks a visitor who already answered (the footer's "Cookie preferences"). */
export function openConsentPrompt(): void {
  if (enabled) setPrompt(true);
}

export function acceptAnalytics(): void {
  setPrompt(false);
  if (!enabled || posthog.get_explicit_consent_status() === "granted") return;
  posthog.opt_in_capturing();
  applyIdentity();
}

export function declineAnalytics(): void {
  setPrompt(false);
  if (!enabled || posthog.get_explicit_consent_status() === "denied") return;
  posthog.opt_out_capturing();
  appliedOrganization = null;
}

/** Ties events to the signed-in user. Held until consent if it has not been given yet. */
export function identifyUser(id: string, properties: Properties = {}): void {
  identity = { id, properties };
  applyIdentity();
}

/** Attaches events to the organization being viewed, for PostHog group analytics. */
export function setOrganization(orgId: string): void {
  organization = orgId;
  applyIdentity();
}

/** On sign-out: forgets the user, but not the visitor's consent answer. */
export function resetAnalytics(): void {
  identity = null;
  organization = null;
  appliedOrganization = null;
  if (!enabled) return;
  const status = posthog.get_explicit_consent_status();
  // reset() also clears the stored consent, which belongs to the visitor, not the account.
  posthog.reset();
  if (status === "granted") posthog.opt_in_capturing({ captureEventName: false });
  else if (status === "denied") posthog.opt_out_capturing();
}

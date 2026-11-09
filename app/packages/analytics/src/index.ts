import type { CaptureResult, PostHog, Properties } from "posthog-js";
import { visitorNeedsConsent } from "./region";
import {
  REVNU_TAG_ENDPOINT,
  REVNU_TAG_SITE,
  REVNU_TAG_SRC,
  revnuAnonymousId,
  revnuConsentForAnalytics,
  revnuIdFromCookies,
  revnuParentCookie,
  revnuTagAllowed,
  type RevnuConsent,
} from "./revnu";

export { revnuAnonymousId, revnuConsentForAnalytics, revnuParentCookie } from "./revnu";

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
 *
 * The SDK (about 330 KB) is imported by `initAnalytics` rather than with this
 * module, so it never holds up a page's first render. Until it arrives the
 * consent answer reads as pending (which sends, stores and loads nothing),
 * identity waits in this module as it does for consent, and events and consent
 * changes queue and run, re-checking consent, once it has.
 */
export interface AnalyticsOptions {
  /** PostHog project API key (`phc_…`). Without one, everything here is a no-op. */
  key: string | undefined;
  /** Ingestion host. Defaults to our managed reverse proxy in front of PostHog US Cloud. */
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
  /**
   * For a surface that can show no consent prompt (the X Player Card embeds on
   * the instances site, inside someone else's page). PostHog stores nothing on
   * the device, records no session and identifies nobody: every visitor gets
   * what a Decline gets, counted by PostHog's server-side hash, so there is
   * nothing to ask about. `captureAnalytics` works without an answer here.
   */
  cookieless?: boolean;
  /** Sent with every event from this page. */
  properties?: Properties;
}

/**
 * PostHog's managed reverse proxy on our own subdomain. First-party ingestion
 * is not on ad-blocker lists the way `*.i.posthog.com` is, so far fewer events
 * and replays go missing. It forwards to the US Cloud project.
 */
const DEFAULT_HOST = "https://hedgehogs.infrawrench.com";
/** Where links the SDK builds (toolbar, replay) point; needed once ingestion goes through a proxy. */
const UI_HOST = "https://us.posthog.com";

let enabled = false;
/** The SDK, once `initAnalytics` has imported and initialised it. */
let posthog: PostHog | null = null;
let loaded: Promise<void> = Promise.resolve();
/** Work that needs the SDK, run in order once it has loaded. */
const queued: Array<(sdk: PostHog) => void> = [];
/** A page that never loads the SDK (blocked, offline) must not grow without bound. */
const MAX_QUEUED = 200;
let cookielessOnly = false;
let promptVisible = false;
const promptListeners = new Set<() => void>();
const revnuBinders = new Set<() => void>();
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

/** Run `work` with the SDK now, or once it has loaded; nothing before `initAnalytics`. */
function withPostHog(work: (sdk: PostHog) => void): void {
  if (posthog) work(posthog);
  else if (enabled && queued.length < MAX_QUEUED) queued.push(work);
}

/** Resolves once the SDK has loaded and initialised (or failed to); for tests. */
export function analyticsLoaded(): Promise<void> {
  return loaded;
}

function consentGranted(): boolean {
  return enabled && posthog?.get_explicit_consent_status() === "granted";
}

/**
 * Identity only ever goes out after consent: in cookieless mode PostHog would
 * attach it to a hashed, storage-free visitor, which is what that mode exists
 * to avoid. `opt_in_capturing` also resets the instance, so this runs after it.
 */
function applyIdentity(): void {
  if (!posthog || !consentGranted()) return;
  if (identity && posthog.get_distinct_id() !== identity.id) {
    posthog.identify(identity.id, identity.properties);
  }
  if (organization && organization !== appliedOrganization) {
    posthog.group("organization", organization);
    appliedOrganization = organization;
  }
}

function notifyRevnuBinders(): void {
  for (const binder of revnuBinders) {
    try {
      binder();
    } catch {
      // A measurement listener must not break the analytics prompt.
    }
  }
}

async function settleConsent(posthog: PostHog): Promise<void> {
  try {
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
  } finally {
    notifyRevnuBinders();
  }
}

/** Starts PostHog once per page. Safe to call during SSR, where it does nothing. */
export function initAnalytics(options: AnalyticsOptions): void {
  if (enabled || !options.key || typeof window === "undefined") return;
  enabled = true;
  const cookieless = options.cookieless ?? false;
  cookielessOnly = cookieless;
  const key = options.key;

  loaded = import("posthog-js").then(
    ({ default: sdk }) => {
      start(sdk, key, options);
      posthog = sdk;
      for (const work of queued.splice(0)) work(sdk);
      // Nothing to settle: the prompt never shows and no consent answer is read.
      if (!cookieless) void settleConsent(sdk);
    },
    () => {
      // Blocked or offline: analytics stays off for this page, as without a key.
      queued.length = 0;
    },
  );
}

function start(posthog: PostHog, key: string, options: AnalyticsOptions): void {
  const { redactUrl, sensitive = false, cookieless = false, properties } = options;
  posthog.init(key, {
    api_host: options.host || DEFAULT_HOST,
    ui_host: UI_HOST,
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    cookieless_mode: cookieless ? "always" : "on_reject",
    disable_session_recording: cookieless,
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

  if (properties) posthog.register(properties);
}

/**
 * Records a product event: after analytics consent has been granted, or at any
 * time on a `cookieless` surface, where the event carries no stored identity.
 */
export function captureAnalytics(event: string, properties: Properties = {}): void {
  withPostHog((sdk) => {
    if (!cookielessOnly && !consentGranted()) return;
    sdk.capture(event, properties);
  });
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
  withPostHog((sdk) => {
    if (sdk.get_explicit_consent_status() === "granted") return;
    sdk.opt_in_capturing();
    applyIdentity();
    notifyRevnuBinders();
  });
}

export function declineAnalytics(): void {
  setPrompt(false);
  withPostHog((sdk) => {
    if (sdk.get_explicit_consent_status() === "denied") return;
    sdk.opt_out_capturing();
    appliedOrganization = null;
    notifyRevnuBinders();
  });
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
  withPostHog((sdk) => {
    const status = sdk.get_explicit_consent_status();
    // reset() also clears the stored consent, which belongs to the visitor, not the account.
    sdk.reset();
    if (status === "granted") sdk.opt_in_capturing({ captureEventName: false });
    else if (status === "denied") sdk.opt_out_capturing();
    notifyRevnuBinders();
  });
}

export interface RevnuConsentSnapshot {
  consentState: RevnuConsent;
  anonymousId: string | null;
}

function analyticsConsentState(): "granted" | "denied" | "pending" | "inactive" {
  if (!enabled) return "inactive";
  // Not loaded yet: pending, which stores, sends and loads nothing. Loading
  // settles consent, which tells the Revnu binders the real answer.
  if (!posthog) return "pending";
  const status = posthog.get_explicit_consent_status();
  if (status === "granted" || status === "denied" || status === "pending") return status;
  return "pending";
}

function readStorage(storage: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

/** The visitor id from the tag, or what a tag on this browser stored earlier. */
function readVisitorId(): string | null {
  const revnu = window.revnu;
  let fromTag: string | null = null;
  try {
    fromTag = revnuAnonymousId(revnu?.getContext?.().anonymousId);
  } catch {
    // Fall through to the property and to storage.
  }
  return (
    fromTag ??
    revnuAnonymousId(revnu?.anonymousId) ??
    revnuIdFromCookies(document.cookie) ??
    revnuAnonymousId(readStorage("localStorage", "revnu_aid"))
  );
}

/**
 * The tag purges itself on denial, but a decline made on another subdomain, or
 * one this page never loaded the tag for, leaves its host-only state behind.
 */
function clearRevnuStorage(): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  for (const name of ["revnu_aid", "revnu_attr"]) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax${secure}`;
  }
  try {
    window.localStorage.removeItem("revnu_aid");
    window.localStorage.removeItem("revnu_attr");
    window.sessionStorage.removeItem("revnu_sid");
  } catch {
    // Blocked storage has nothing of ours in it either.
  }
}

let revnuTagRequested = false;

function loadRevnuTag(onLoad: () => void): void {
  if (revnuTagRequested) return;
  revnuTagRequested = true;
  const script = document.createElement("script");
  script.src = REVNU_TAG_SRC;
  script.async = true;
  script.setAttribute("data-site", REVNU_TAG_SITE);
  script.setAttribute("data-endpoint", REVNU_TAG_ENDPOINT);
  script.setAttribute("data-consent", "granted");
  script.addEventListener("load", onLoad);
  document.head.appendChild(script);
}

/** Runs `listener` after every client-side navigation that changes the path. */
function watchPathname(listener: () => void): void {
  let last = window.location.pathname;
  const check = () => {
    if (window.location.pathname === last) return;
    last = window.location.pathname;
    listener();
  };
  for (const name of ["pushState", "replaceState"] as const) {
    const original = window.history[name];
    window.history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      original.apply(this, args);
      check();
    };
  }
  window.addEventListener("popstate", check);
}

function referrerPathname(): string | null {
  try {
    const referrer = new URL(document.referrer);
    return referrer.origin === window.location.origin ? referrer.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Follow the analytics answer with the Revnu tag. The tag is only added to the
 * page once consent is granted, so before that nothing contacts revnu.com, and
 * a slow revnu.com can never hold up the page. Without a PostHog key nobody has
 * been asked, so the tag stays out. Call this only from the website and the web
 * app, and after `initAnalytics`. The instances site does not.
 *
 * `holdPath` names paths the tag must never see: it sends the current path, and
 * its own redaction only knows a few labels. Client-side navigation onto one
 * suspends a running tag. The watcher is installed before the tag loads, so its
 * history hooks run first and the tag is already suspended when its own run.
 * The tag also reports `document.referrer`, so a page reached from a held path
 * stays without it until the next full load.
 */
export function bindRevnuToAnalyticsConsent(options?: {
  holdPath?: (pathname: string) => boolean;
  onChange?: (snapshot: RevnuConsentSnapshot) => void;
}): () => void {
  if (typeof window === "undefined") return () => {};
  const holdPath = options?.holdPath;
  const referrer = holdPath ? referrerPathname() : null;
  const cameFromHeld = referrer !== null && holdPath !== undefined && holdPath(referrer);
  const apply = () => {
    const consentState = revnuConsentForAnalytics(analyticsConsentState());
    const beforeDenial = readVisitorId();
    const held = cameFromHeld || (holdPath?.(window.location.pathname) ?? false);
    if (consentState === "granted" && !held) {
      if (window.revnu) window.revnu.consent?.("granted");
      else if (revnuTagAllowed(window.location.hostname, window.location.protocol)) {
        loadRevnuTag(apply);
      }
    } else {
      window.revnu?.consent?.(consentState === "denied" ? "denied" : "pending");
    }
    if (consentState === "denied") clearRevnuStorage();
    const anonymousId = consentState === "denied" ? beforeDenial : readVisitorId();
    const cookie = revnuParentCookie(
      consentState,
      anonymousId,
      window.location.hostname,
      window.location.protocol,
    );
    if (cookie) document.cookie = cookie;
    options?.onChange?.({ consentState, anonymousId });
  };
  revnuBinders.add(apply);
  if (holdPath || options?.onChange) {
    watchPathname(() => {
      if (revnuBinders.has(apply)) apply();
    });
  }
  apply();
  return () => {
    revnuBinders.delete(apply);
  };
}

/**
 * What to attach to a Stripe checkout. Consent comes from the analytics answer
 * rather than the tag, which is absent until a grant and may be blocked even
 * then. The visitor id is only sent after a grant.
 */
export function readRevnuMeasurement():
  { consentState: RevnuConsent; anonymousId?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  const consentState = revnuConsentForAnalytics(analyticsConsentState());
  const anonymousId = consentState === "granted" ? readVisitorId() : null;
  return anonymousId ? { consentState, anonymousId } : { consentState };
}

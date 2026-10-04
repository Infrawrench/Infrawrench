import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * Where a Sentry organization lives. sentry.io stores each organization's
 * data in one region (US or DE) and answers org-scoped calls on that
 * region's host; a self-hosted install answers everything on its own base
 * URL. The user picks the region they signed up in (or self-hosted plus the
 * URL) and the plugin resolves the hosts.
 *
 * Hosts verified against "API Reference: Requests"
 * (https://docs.sentry.io/api/requests/, 2026-10): `https://us.sentry.io` and
 * `https://de.sentry.io` are the regional API hosts; `https://sentry.io`
 * remains a region-agnostic control host that lists organizations with each
 * one's `links.regionUrl`.
 */
export interface SentryInstance {
  /** Stable id stored in the credential: `us`, `de` or `self-hosted`. */
  id: string;
  label: string;
  /** Origin org-scoped API calls go to (no trailing slash, no `/api/0`). */
  apiUrl: string;
  /** Web UI origin, used for deep links. */
  appUrl: string;
  /** True for a self-hosted install: no usage-stats pricing, no regions. */
  selfHosted: boolean;
}

export const SENTRY_REGIONS: Array<
  Omit<SentryInstance, "selfHosted"> & { flag: string; location: string }
> = [
  {
    id: "us",
    label: "US",
    apiUrl: "https://us.sentry.io",
    appUrl: "https://sentry.io",
    flag: "🇺🇸",
    location: "sentry.io (United States)",
  },
  {
    id: "de",
    label: "DE",
    apiUrl: "https://de.sentry.io",
    appUrl: "https://sentry.io",
    flag: "🇩🇪",
    location: "sentry.io (Germany, EU data residency)",
  },
];

export const SELF_HOSTED_ID = "self-hosted";
export const DEFAULT_REGION_ID = "us";

/** The region-agnostic control host, for the organization picker on sentry.io. */
export const SENTRY_CONTROL_URL = "https://sentry.io";

/** Every sentry.io API host the plugin talks to, for the bastion egress allowlist. */
export const SENTRY_API_HOSTS = ["sentry.io", ...SENTRY_REGIONS.map((r) => new URL(r.apiUrl).host)];

export const REGION_PICKER: CredentialFieldRegion[] = [
  ...SENTRY_REGIONS.map((r) => ({ id: r.id, label: r.label, location: r.location, flag: r.flag })),
  { id: SELF_HOSTED_ID, label: "Self-hosted", location: "Your own Sentry install", flag: "🏠" },
];

/** Normalise a pasted self-hosted URL to its origin plus any path prefix, minus `/api/0`. */
export function normaliseBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api(\/0)?$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Resolve the stored region (and, for self-hosted, base URL) to an instance.
 * Accepts the picker id, the label or a host pasted from a URL. Blank means
 * US, sentry.io's default. A base URL on its own implies self-hosted.
 */
export function resolveInstance(
  rawRegion: string | undefined,
  rawBaseUrl?: string | undefined,
): SentryInstance {
  const region = (rawRegion ?? "").trim().toLowerCase();
  const baseUrl = normaliseBaseUrl(rawBaseUrl ?? "");
  if (region === SELF_HOSTED_ID || region === "self hosted" || (!region && baseUrl)) {
    if (!baseUrl) {
      throw new Error(
        "Sentry plugin: a self-hosted account needs its base URL, e.g. https://sentry.example.com.",
      );
    }
    const host = new URL(baseUrl).host;
    if (host === "sentry.io" || host.endsWith(".sentry.io")) {
      return resolveInstance(host.startsWith("de.") ? "de" : "us");
    }
    return {
      id: SELF_HOSTED_ID,
      label: "Self-hosted",
      apiUrl: baseUrl,
      appUrl: baseUrl,
      selfHosted: true,
    };
  }
  const found = !region
    ? SENTRY_REGIONS[0]
    : SENTRY_REGIONS.find(
        (r) =>
          r.id === region || r.label.toLowerCase() === region || new URL(r.apiUrl).host === region,
      );
  if (!found) {
    throw new Error(`Sentry plugin: unknown region "${rawRegion}". Pick US, DE or Self-hosted.`);
  }
  return {
    id: found.id,
    label: found.label,
    apiUrl: found.apiUrl,
    appUrl: found.appUrl,
    selfHosted: false,
  };
}

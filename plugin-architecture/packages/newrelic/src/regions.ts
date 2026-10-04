import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * New Relic data centre regions. An organization's data lives in exactly one
 * region and a user key only answers on that region's NerdGraph endpoint, so
 * the user picks the region they sign in to and the plugin resolves the host.
 *
 * Endpoints verified against "Introduction to NerdGraph"
 * (https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/,
 * 2026-10): `api.newrelic.com`, `api.eu.newrelic.com`, `api.jp.newrelic.com`.
 */
export interface NewRelicRegion {
  /** Stable id stored in the credential. */
  id: string;
  label: string;
  /** NerdGraph endpoint. */
  graphqlUrl: string;
  /** Web UI origin, used for deep links. */
  appUrl: string;
  flag: string;
  location: string;
}

export const NEWRELIC_REGIONS: NewRelicRegion[] = [
  {
    id: "us",
    label: "US",
    graphqlUrl: "https://api.newrelic.com/graphql",
    appUrl: "https://one.newrelic.com",
    flag: "🇺🇸",
    location: "one.newrelic.com",
  },
  {
    id: "eu",
    label: "EU",
    graphqlUrl: "https://api.eu.newrelic.com/graphql",
    appUrl: "https://one.eu.newrelic.com",
    flag: "🇪🇺",
    location: "one.eu.newrelic.com",
  },
  {
    id: "jp",
    label: "JP",
    graphqlUrl: "https://api.jp.newrelic.com/graphql",
    appUrl: "https://one.jp.newrelic.com",
    flag: "🇯🇵",
    location: "one.jp.newrelic.com",
  },
];

export const DEFAULT_REGION_ID = "us";

/** Every API host the plugin talks to, for the bastion egress allowlist. */
export const NEWRELIC_API_HOSTS = NEWRELIC_REGIONS.map((r) => new URL(r.graphqlUrl).host);

export const REGION_PICKER: CredentialFieldRegion[] = NEWRELIC_REGIONS.map((r) => ({
  id: r.id,
  label: r.label,
  location: r.location,
  flag: r.flag,
}));

/**
 * Resolve a stored credential value to a region. Accepts the picker id, the
 * label or a UI/API host, so a value pasted from a URL still resolves. Blank
 * means US, New Relic's default.
 */
export function resolveRegion(raw: string | undefined): NewRelicRegion {
  const value = (raw ?? "").trim().toLowerCase();
  const fallback = NEWRELIC_REGIONS[0]!;
  if (!value) return fallback;
  const found = NEWRELIC_REGIONS.find(
    (r) =>
      r.id === value ||
      r.label.toLowerCase() === value ||
      new URL(r.appUrl).host === value ||
      new URL(r.graphqlUrl).host === value,
  );
  if (!found) {
    throw new Error(
      `New Relic plugin: unknown region "${raw}". Pick one of ${NEWRELIC_REGIONS.map((r) => r.label).join(", ")}.`,
    );
  }
  return found;
}

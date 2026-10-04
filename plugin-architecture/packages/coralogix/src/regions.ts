import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * Coralogix regions ("domains" in Coralogix's own vocabulary). Every team
 * lives in exactly one, API keys only authenticate against that region's API
 * host, and the region is named after the address people sign in at, which is
 * not derivable from the region label (`<team>.coralogix.com` is EU1,
 * `<team>.app.coralogix.us` is US1, `<team>.app.cx498.coralogix.com` is US2).
 * So the user picks the region and the plugin resolves the host.
 *
 * Verified against the domain table on
 * https://coralogix.com/docs/integrations/coralogix-endpoints/ and the
 * `servers` list of Coralogix's published OpenAPI document
 * (`https://api.eu2.coralogix.com/mgmt/openapi/5/openapi.yaml`), 2026-10.
 * The OpenAPI document still lists the older hostnames (`api.coralogix.us`,
 * `api.cx498.coralogix.com`, ...); the regional `api.<region>.coralogix.com`
 * names from the endpoints page answer on the same paths and are the ones
 * Coralogix documents going forward, so those are used.
 */
export interface CoralogixRegion {
  /** Stable id stored in the credential, e.g. "eu2". */
  id: string;
  /** Coralogix's label, e.g. "EU2". */
  label: string;
  /** The Coralogix domain, e.g. "eu2.coralogix.com". */
  domain: string;
  /** Team sign-in hostname suffix, e.g. "app.eu2.coralogix.com". */
  teamHostSuffix: string;
  /** API origin, without a trailing slash. */
  apiUrl: string;
  /** Cloud region the Coralogix region runs in. */
  location: string;
  flag: string;
  /** True for the FedRAMP environment, where only logs, metrics and traces are in scope. */
  government?: boolean;
}

export const CORALOGIX_REGIONS: CoralogixRegion[] = [
  {
    id: "eu1",
    label: "EU1",
    domain: "eu1.coralogix.com",
    teamHostSuffix: "coralogix.com",
    apiUrl: "https://api.eu1.coralogix.com",
    location: "AWS eu-west-1 (Ireland)",
    flag: "🇮🇪",
  },
  {
    id: "eu2",
    label: "EU2",
    domain: "eu2.coralogix.com",
    teamHostSuffix: "app.eu2.coralogix.com",
    apiUrl: "https://api.eu2.coralogix.com",
    location: "AWS eu-north-1 (Stockholm)",
    flag: "🇸🇪",
  },
  {
    id: "us1",
    label: "US1",
    domain: "us1.coralogix.com",
    teamHostSuffix: "app.coralogix.us",
    apiUrl: "https://api.us1.coralogix.com",
    location: "AWS us-east-2 (Ohio)",
    flag: "🇺🇸",
  },
  {
    id: "us2",
    label: "US2",
    domain: "us2.coralogix.com",
    teamHostSuffix: "app.cx498.coralogix.com",
    apiUrl: "https://api.us2.coralogix.com",
    location: "AWS us-west-2 (Oregon)",
    flag: "🇺🇸",
  },
  {
    id: "us3",
    label: "US3",
    domain: "us3.coralogix.com",
    teamHostSuffix: "app.us3.coralogix.com",
    apiUrl: "https://api.us3.coralogix.com",
    location: "GCP us-central1 (Iowa)",
    flag: "🇺🇸",
  },
  {
    id: "ap1",
    label: "AP1",
    domain: "ap1.coralogix.com",
    teamHostSuffix: "app.coralogix.in",
    apiUrl: "https://api.ap1.coralogix.com",
    location: "AWS ap-south-1 (Mumbai)",
    flag: "🇮🇳",
  },
  {
    id: "ap2",
    label: "AP2",
    domain: "ap2.coralogix.com",
    teamHostSuffix: "app.coralogixsg.com",
    apiUrl: "https://api.ap2.coralogix.com",
    location: "AWS ap-southeast-1 (Singapore)",
    flag: "🇸🇬",
  },
  {
    id: "ap3",
    label: "AP3",
    domain: "ap3.coralogix.com",
    teamHostSuffix: "app.ap3.coralogix.com",
    apiUrl: "https://api.ap3.coralogix.com",
    location: "AWS ap-southeast-3 (Jakarta)",
    flag: "🇮🇩",
  },
  {
    id: "gov1",
    label: "GOV1",
    domain: "gov1.coralogixgov.us",
    teamHostSuffix: "app.gov1.coralogixgov.us",
    apiUrl: "https://api.gov1.coralogixgov.us",
    location: "AWS GovCloud us-gov-west-1",
    flag: "🇺🇸",
    government: true,
  },
];

export const DEFAULT_REGION_ID = "eu1";

/** Every API host the plugin can talk to, for the bastion egress allowlist. */
export const CORALOGIX_API_HOSTS = CORALOGIX_REGIONS.map((r) => new URL(r.apiUrl).host);

export const REGION_PICKER: CredentialFieldRegion[] = CORALOGIX_REGIONS.map((r) => ({
  id: r.id,
  label: r.label,
  location: `${r.location}, ${r.teamHostSuffix}`,
  flag: r.flag,
}));

/**
 * Resolve a stored credential value to a region. Accepts the picker id
 * ("eu2"), Coralogix's label ("EU2"), the Coralogix domain
 * ("eu2.coralogix.com"), the legacy domains people still paste from older
 * docs ("coralogix.com", "coralogix.us", "cx498.coralogix.com", "coralogix.in",
 * "coralogixsg.com") and a full team hostname ("acme.app.coralogix.us"), so an
 * account added by hand or through config-as-code still resolves. Blank means
 * EU1, Coralogix's original region.
 */
export function resolveRegion(raw: string | undefined): CoralogixRegion {
  const value = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const fallback = CORALOGIX_REGIONS.find((r) => r.id === DEFAULT_REGION_ID)!;
  if (!value) return fallback;
  const legacy: Record<string, string> = {
    "coralogix.com": "eu1",
    "api.coralogix.com": "eu1",
    "coralogix.us": "us1",
    "api.coralogix.us": "us1",
    "cx498.coralogix.com": "us2",
    "api.cx498.coralogix.com": "us2",
    "coralogix.in": "ap1",
    "api.coralogix.in": "ap1",
    "coralogixsg.com": "ap2",
    "api.coralogixsg.com": "ap2",
  };
  const byId =
    CORALOGIX_REGIONS.find(
      (r) =>
        r.id === value ||
        r.label.toLowerCase() === value ||
        r.domain === value ||
        new URL(r.apiUrl).host === value,
    ) ?? CORALOGIX_REGIONS.find((r) => r.id === legacy[value]);
  if (byId) return byId;
  // A team hostname: longest suffix wins, so "x.app.coralogix.us" does not
  // match EU1's bare "coralogix.com".
  const bySuffix = [...CORALOGIX_REGIONS]
    .sort((a, b) => b.teamHostSuffix.length - a.teamHostSuffix.length)
    .find((r) => value.endsWith(`.${r.teamHostSuffix}`));
  if (bySuffix) return bySuffix;
  throw new Error(
    `Coralogix plugin: unknown region "${raw}". Pick one of ${CORALOGIX_REGIONS.map((r) => r.label).join(", ")}.`,
  );
}

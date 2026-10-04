import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * Datadog sites. Every Datadog organization lives on exactly one site, keys
 * only authenticate against that site's API host, and the hosts are not
 * derivable from the site label (US1 is `api.datadoghq.com`, EU is
 * `api.datadoghq.eu`, US1-FED is `api.ddog-gov.com`), so the user picks the
 * site by the name they see in their Datadog URL and the plugin resolves the
 * host.
 *
 * Verified against the `servers.variables.site.enum` of Datadog's published
 * OpenAPI documents (DataDog/datadog-api-client-typescript,
 * `.generator/schemas/v2/openapi.yaml`) and the endpoint tables on
 * https://docs.datadoghq.com/api/latest/usage-metering/ (2026-10).
 */
export interface DatadogSite {
  /** Stable id stored in the credential. */
  id: string;
  /** Datadog's own label for the site, e.g. "US1". */
  label: string;
  /** The `site` value Datadog documents (`DD_SITE`). */
  site: string;
  /** Web app origin, used for deep links into Datadog. */
  appUrl: string;
  /** API origin, without a trailing slash. */
  apiUrl: string;
  flag: string;
  location: string;
  /** True for the FedRAMP sites, where some usage endpoints are unavailable. */
  government?: boolean;
}

export const DATADOG_SITES: DatadogSite[] = [
  {
    id: "us1",
    label: "US1",
    site: "datadoghq.com",
    appUrl: "https://app.datadoghq.com",
    apiUrl: "https://api.datadoghq.com",
    flag: "🇺🇸",
    location: "app.datadoghq.com",
  },
  {
    id: "us3",
    label: "US3",
    site: "us3.datadoghq.com",
    appUrl: "https://us3.datadoghq.com",
    apiUrl: "https://api.us3.datadoghq.com",
    flag: "🇺🇸",
    location: "us3.datadoghq.com",
  },
  {
    id: "us5",
    label: "US5",
    site: "us5.datadoghq.com",
    appUrl: "https://us5.datadoghq.com",
    apiUrl: "https://api.us5.datadoghq.com",
    flag: "🇺🇸",
    location: "us5.datadoghq.com",
  },
  {
    id: "eu1",
    label: "EU",
    site: "datadoghq.eu",
    appUrl: "https://app.datadoghq.eu",
    apiUrl: "https://api.datadoghq.eu",
    flag: "🇪🇺",
    location: "app.datadoghq.eu",
  },
  {
    id: "ap1",
    label: "AP1",
    site: "ap1.datadoghq.com",
    appUrl: "https://ap1.datadoghq.com",
    apiUrl: "https://api.ap1.datadoghq.com",
    flag: "🇯🇵",
    location: "ap1.datadoghq.com",
  },
  {
    id: "ap2",
    label: "AP2",
    site: "ap2.datadoghq.com",
    appUrl: "https://ap2.datadoghq.com",
    apiUrl: "https://api.ap2.datadoghq.com",
    flag: "🇦🇺",
    location: "ap2.datadoghq.com",
  },
  {
    id: "uk1",
    label: "UK1",
    site: "uk1.datadoghq.com",
    appUrl: "https://uk1.datadoghq.com",
    apiUrl: "https://api.uk1.datadoghq.com",
    flag: "🇬🇧",
    location: "uk1.datadoghq.com",
  },
  {
    id: "us1-fed",
    label: "US1-FED",
    site: "ddog-gov.com",
    appUrl: "https://app.ddog-gov.com",
    apiUrl: "https://api.ddog-gov.com",
    flag: "🇺🇸",
    location: "app.ddog-gov.com",
    government: true,
  },
  {
    id: "us2-fed",
    label: "US2-FED",
    site: "us2.ddog-gov.com",
    appUrl: "https://us2.ddog-gov.com",
    apiUrl: "https://api.us2.ddog-gov.com",
    flag: "🇺🇸",
    location: "us2.ddog-gov.com",
    government: true,
  },
];

export const DEFAULT_SITE_ID = "us1";

/** Every API host the plugin can talk to, for the bastion egress allowlist. */
export const DATADOG_API_HOSTS = DATADOG_SITES.map((s) => new URL(s.apiUrl).host);

export const SITE_REGIONS: CredentialFieldRegion[] = DATADOG_SITES.map((s) => ({
  id: s.id,
  label: s.label,
  location: s.location,
  flag: s.flag,
}));

/**
 * Resolve a stored credential value to a site. Accepts the picker id ("eu1"),
 * Datadog's own label ("EU", "US1-FED") or the documented `DD_SITE` value
 * ("datadoghq.eu"), so an account added by hand or through config-as-code
 * with the value people copy from Datadog's docs still resolves. Blank means
 * US1, which is Datadog's own default.
 */
export function resolveSite(raw: string | undefined): DatadogSite {
  const value = (raw ?? "").trim().toLowerCase();
  const fallback = DATADOG_SITES[0]!;
  if (!value) return fallback;
  const found = DATADOG_SITES.find(
    (s) =>
      s.id === value ||
      s.label.toLowerCase() === value ||
      s.site === value ||
      `app.${s.site}` === value ||
      new URL(s.appUrl).host === value,
  );
  if (!found) {
    throw new Error(
      `Datadog plugin: unknown site "${raw}". Pick one of ${DATADOG_SITES.map((s) => s.label).join(", ")}.`,
    );
  }
  return found;
}

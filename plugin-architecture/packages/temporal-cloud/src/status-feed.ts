/**
 * Temporal public status feed (Atlassian Statuspage at
 * https://status.temporal.io; components verified 2026-10 against
 * `/api/v2/components.json`).
 *
 * Components are either cloud regions, grouped under "Amazon Web Services
 * (AWS)" and "Google Cloud Provider (GCP)" and named by the bare provider
 * region (`us-east-1`, `us-central1`), or global services ("Cloud Ops API",
 * "Namespace Management", "Metrics", "Billing", …). Regions map onto
 * Temporal's own region ids (`aws-us-east-1`, `gcp-us-central1`): AWS names
 * end in `-<digit>`, GCP names end in a digit with no hyphen before it.
 * Authentication and the Cloud Ops API escalate to provider-wide, since every
 * namespace and every call this plugin makes depends on them.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.temporal.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.temporal.io",
};

const PROVIDER_WIDE = new Set(["Auth(n)/Auth(z)", "Cloud Ops API"]);
const GROUPS = new Set([
  "Amazon Web Services (AWS)",
  "Google Cloud Provider (GCP)",
  "Global Services",
]);

export function regionIdForComponent(name: string): string | null {
  if (/^[a-z]+(-[a-z]+)+-\d+$/.test(name)) return `aws-${name}`;
  if (/^[a-z]+-[a-z]+\d+$/.test(name)) return `gcp-${name}`;
  return null;
}

function mapComponent(name: string): StatusComponentMapping | null {
  if (GROUPS.has(name)) return { providerWide: true };
  const region = regionIdForComponent(name);
  if (region) return { regions: [region] };
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

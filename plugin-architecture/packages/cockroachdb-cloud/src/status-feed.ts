/**
 * CockroachDB Cloud public status feed (Atlassian Statuspage,
 * https://status.cockroachlabs.cloud: verified 2026-10).
 *
 * Components are products ("CockroachDB Basic/Standard", "CockroachDB
 * Advanced", the Continuum editions), shared surfaces ("Cloud Console",
 * "User Authentication", "Shared Services", "Telemetry & Metrics") and
 * geographic groups ("US-1", "EU-2", "AU"…) that do not name a cloud region,
 * so they cannot be matched to a cluster's region. Product components scope
 * to clusters; the console, authentication and shared services are what this
 * plugin talks to and escalate to provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.cockroachlabs.cloud/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.cockroachlabs.cloud",
};

const PROVIDER_WIDE = new Set([
  "Cloud Console",
  "User Authentication",
  "Shared Services",
  "CockroachDB Cloud",
]);

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (PROVIDER_WIDE.has(trimmed)) return { services: [trimmed], providerWide: true };
  if (/CockroachDB|Continuum/i.test(trimmed)) {
    return { services: [trimmed], resourceTypes: ["crdb-cluster"] };
  }
  if (/Telemetry|Metrics/i.test(trimmed)) {
    return { services: [trimmed], resourceTypes: ["crdb-metric-export", "crdb-log-export"] };
  }
  return { services: [trimmed] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

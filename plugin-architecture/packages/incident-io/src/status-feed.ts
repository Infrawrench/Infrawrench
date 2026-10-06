/**
 * incident.io's own status page (status.incident.io, an incident.io status
 * page) serves a Statuspage-compatible `GET /api/v2/incidents.json` (verified
 * 2026-10; `/api/v2/incidents/unresolved.json` 404s, so the full list is read
 * and the parser keeps the unresolved ones). Components are products with no
 * regions; the API, dashboard and alert ingestion/paging are what every
 * incident.io account here depends on.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.incident.io/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.incident.io",
};

const PROVIDER_WIDE = new Set(["API", "Dashboard", "Alert ingestion, processing and paging"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

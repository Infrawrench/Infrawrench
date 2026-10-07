/**
 * Axiom public status feed (https://status.axiom.co, an incident.io page
 * emulating the Statuspage v2 API; verified 2026-10).
 *
 * incident.io serves no `/incidents/unresolved.json`, so this fetches
 * `/api/v2/incidents.json` (history) and keeps the unresolved incidents. The
 * page has a US and an EU group with identically named components (API,
 * Ingest, Querying, Alerting, Endpoints, App), and incidents name components
 * without their group, so incidents cannot be scoped to an edge deployment:
 * they map to services, and API and App outages are provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.axiom.co/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.axiom.co",
};

const PROVIDER_WIDE = new Set(["API", "App"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  return PROVIDER_WIDE.has(name) ? { services: [name], providerWide: true } : { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((i) => i.state !== "resolved" && !i.resolvedAt);
}

/**
 * Perplexity public status feed (incident.io emulating Statuspage v2,
 * https://status.perplexity.com; verified 2026-10). incident.io 404s on
 * `/incidents/unresolved.json`, so the full history is fetched and filtered.
 * Components: "API" (provider-wide for this plugin) plus "Website", "App" and
 * "Computer", which are consumer surfaces and ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.perplexity.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.perplexity.com",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "API") return { services: [name], providerWide: true };
  return null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

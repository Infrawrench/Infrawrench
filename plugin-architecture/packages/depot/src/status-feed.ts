/**
 * Depot public status feed (incident.io emulating the Statuspage v2 API,
 * https://status.depot.dev: verified 2026-10).
 *
 * incident.io serves no `/incidents/unresolved.json`, so this fetches the
 * full `/api/v2/incidents.json` history and keeps the unresolved ones. The
 * page's components are Dashboard, API, Depot CI, the two builder regions
 * (us-east-1, eu-central-1), Depot Cache and Container Registry. The regions
 * map onto project regions; the API is what every listing and cost pass
 * calls, so it escalates to provider-wide; the dashboard affects nothing
 * this plugin manages.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.depot.dev/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.depot.dev",
};

const REGIONS = new Set(["us-east-1", "eu-central-1"]);

function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "Dashboard") return null;
  if (REGIONS.has(name)) return { regions: [name], services: ["Container builds"] };
  if (name === "API") return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

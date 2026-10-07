/**
 * Paperspace public status feed (Atlassian Statuspage,
 * https://status.paperspace.com, verified 2026-10). Components are the three
 * regions as "US (NY2)", "US (CA1)", "Europe (AMS1)", which map to the region
 * codes machines store, plus "API", "Console", "Gradient" (Notebooks,
 * Deployments, Workflows) and "Desktop App & Streaming".
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.paperspace.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.paperspace.com",
};

const REGION = /\(([A-Z]+\d+)\)\s*$/;

export function mapComponent(name: string): StatusComponentMapping | null {
  const m = REGION.exec(name);
  if (m) return { regions: [m[1]!.toLowerCase()] };
  switch (name) {
    case "API":
    case "Console":
      return { services: [name], providerWide: true };
    case "Gradient":
      return { services: [name], resourceTypes: ["deployment"] };
    case "Desktop App & Streaming":
      return { services: [name], resourceTypes: ["machine"] };
    default:
      return { services: [name] };
  }
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

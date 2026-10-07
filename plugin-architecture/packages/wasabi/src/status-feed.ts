import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

/**
 * status.wasabi.com is Atlassian Statuspage (verified 2026-10-06). Components
 * are regions named like "US-Central-1 (Texas)" or "US-East-1-Dell-OBS
 * (N. Virginia)"; the leading id lowercased is the plugin's region id. Non
 * region components (the console, billing) make an incident provider-wide.
 */
export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.wasabi.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.wasabi.com",
};

const REGION_RE = /^([A-Z]{2}-[A-Z]+-\d)\b/i;

export function mapComponent(name: string): {
  regions?: string[];
  services?: string[];
  providerWide?: boolean;
} {
  const m = REGION_RE.exec(name.trim());
  if (m) return { regions: [m[1]!.toLowerCase()], services: ["Hot Cloud Storage"] };
  return { services: [name], providerWide: true };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: "https://status.wasabi.com",
  });
}

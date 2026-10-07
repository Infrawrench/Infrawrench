/**
 * Voyage AI public status feed (Atlassian Statuspage; status.voyageai.com
 * 301s to https://voyageai-status.statuspage.io, used directly; verified
 * 2026-10). Components: "API" (provider-wide) and "User Dashboard" (not an
 * API surface, ignored).
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://voyageai-status.statuspage.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://voyageai-status.statuspage.io",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (/dashboard/i.test(name)) return null;
  return { services: [name], providerWide: true };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

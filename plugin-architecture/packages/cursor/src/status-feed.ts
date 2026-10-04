/**
 * Cursor public status feed (Atlassian Statuspage at https://status.cursor.com,
 * verified 2026-10-04: `/api/v2/incidents/unresolved.json` answers with the
 * standard Statuspage shape).
 *
 * Components at verification time: "IDE", "CLI", "Cloud Agents", "Review
 * Agents", "Automations", "cursor.com", "Origin", "Grok Bot". `cursor.com`
 * hosts the dashboard and the Admin API this plugin reads, so an incident on it
 * is provider-wide for this plugin; the rest pass through as services.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.cursor.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.cursor.com",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (name.toLowerCase() === "cursor.com") return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

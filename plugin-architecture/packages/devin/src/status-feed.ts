/**
 * Devin's public status page (Atlassian Statuspage at https://www.devinstatus.com,
 * which status.devin.ai redirects to; components checked 2026-10 against
 * `/api/v2/components.json`).
 *
 * Components come in pairs, "Cloud Agent" and "Cloud Agent (Enterprise)", under
 * an "Enterprise" group; the suffix is dropped so each maps to one service.
 * Cloud Agent incidents escalate to provider-wide and mark sessions, since
 * every session runs there.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.devinstatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.devinstatus.com",
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const service = name.replace(/\s*\(Enterprise\)\s*$/, "").trim();
  if (!service || service === "Enterprise") return null;
  if (service === "Cloud Agent") {
    return { services: [service], resourceTypes: ["session"], providerWide: true };
  }
  return { services: [service] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

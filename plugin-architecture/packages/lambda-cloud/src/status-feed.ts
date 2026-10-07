/**
 * Lambda public status feed (https://status.lambda.ai, an incident.io status
 * page; verified 2026-10). incident.io emulates the Statuspage v2 API but
 * 404s on `/incidents/unresolved.json`, so this reads `/api/v2/incidents.json`
 * (recent history) and keeps the unresolved ones.
 *
 * Components are product areas ("Cloud API", "Virtual Machines", "Storage",
 * "Network", "Power", "Website", "Chat Completions API" plus Cloudflare
 * dependencies). Regions only appear in incident titles, upper-cased
 * ("US-SOUTH-2 Scheduled Maintenance"), so they are lifted from the title and
 * lower-cased to match the region codes instances store.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.lambda.ai/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.lambda.ai",
};

export function mapComponent(name: string): StatusComponentMapping | null {
  switch (name) {
    case "Website":
    case "Chat Completions API":
      // Neither affects the resources this plugin manages.
      return null;
    case "Virtual Machines":
      return { services: [name], resourceTypes: ["instance"] };
    case "Storage":
      return { services: [name], resourceTypes: ["filesystem"] };
    case "Cloud API":
      return { services: [name], providerWide: true };
    default:
      return { services: [name] };
  }
}

const REGION_IN_TITLE = /\b([a-z]{2}-[a-z]+-\d+)\b/gi;

export function regionsInTitle(title: string): string[] {
  return [...new Set([...title.matchAll(REGION_IN_TITLE)].map((m) => m[1]!.toLowerCase()))];
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  })
    .filter((incident) => incident.state !== "resolved" && !incident.resolvedAt)
    .map((incident) => {
      const regions = regionsInTitle(incident.title);
      if (regions.length === 0) return incident;
      // A titled region scopes the incident even when no component was named.
      return {
        ...incident,
        regions: [...new Set([...incident.regions, ...regions])],
        providerWide: false,
      };
    });
}

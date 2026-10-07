/**
 * Honeycomb public status feed (Atlassian Statuspage, https://status.honeycomb.io;
 * verified 2026-10 against `/api/v2/components.json`).
 *
 * Components are named `<host> - <REGION> <Service>`, for example
 * "ui.eu1.honeycomb.io - EU1 Querying" or "api.honeycomb.io - US1 Event
 * Ingest". The region becomes the plugin's region id (`us1`, `eu1`), which
 * is what every resource carries in `fields.region`, and the rest becomes the
 * service name. App Interface and Querying outages break everything this
 * plugin shows in that region. The marketing site and the Sandbox are
 * ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.honeycomb.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.honeycomb.io",
};

const COMPONENT = /^\S+\s+-\s+(US1|EU1)\s+(.+)$/i;

export function mapComponent(name: string): StatusComponentMapping | null {
  const m = COMPONENT.exec(name.trim());
  if (!m) {
    if (/^www\.honeycomb\.io$/i.test(name.trim()) || /sandbox/i.test(name)) return null;
    return { services: [name] };
  }
  const region = (m[1] ?? "").toLowerCase();
  const service = (m[2] ?? "").trim();
  return { regions: [region], services: [service] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

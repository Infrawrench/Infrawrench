/**
 * MongoDB Cloud public status feed (Atlassian Statuspage,
 * https://status.mongodb.com; verified 2026-10 against
 * `/api/v2/components.json`).
 *
 * The page lists one component per product ("MongoDB Cloud", "MongoDB Atlas
 * Search", "MongoDB Atlas Data Federation and Online Archive", …).
 * "MongoDB Cloud" is the control plane and the clusters themselves, so it is
 * provider-wide; the rest map to their product. The support portal says
 * nothing about anyone's infrastructure and is dropped.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.mongodb.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.mongodb.com",
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (!trimmed || /support portal/i.test(trimmed)) return null;
  if (trimmed === "MongoDB Cloud") return { services: ["Atlas"], providerWide: true };
  const service = trimmed.replace(/^MongoDB\s+(Atlas\s+)?/i, "") || trimmed;
  return { services: [service] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

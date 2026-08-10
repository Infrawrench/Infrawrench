/**
 * ClickHouse Cloud public status feed (incident.io emulating the Statuspage
 * v2 API, https://status.clickhouse.com — verified 2026-08).
 *
 * incident.io hosts 404 on /incidents/unresolved.json, so this fetches
 * /api/v2/incidents.json (full history) and filters to unresolved after
 * parsing. Incident objects carry no components — the parser marks them
 * provider-wide automatically. The component mapper is future-proofing:
 * components on this page are regions with inconsistent naming — "AWS
 * ap-east-1", "GCP us-west1", "AWS  us-west-2" (double space), bare
 * "us-east-2" — so the region slug is the last whitespace-separated token.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.clickhouse.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.clickhouse.com",
};

/** Lowercase region slug: us-east-2, us-west1, ap-east-1, … */
const REGION_SLUG = /^[a-z0-9-]+$/;

function mapComponent(name: string): StatusComponentMapping | null {
  const tokens = name.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (last && REGION_SLUG.test(last)) return { regions: [last] };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  // The feed is full history — keep only active incidents; the host closes
  // cached rows that disappear from the parsed set.
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

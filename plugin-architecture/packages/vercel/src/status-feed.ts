/**
 * Vercel public status feed (Atlassian Statuspage,
 * https://www.vercel-status.com — verified 2026-08).
 *
 * Edge-region components are named "ARN1 - Stockholm, Sweden" (IATA-style
 * code + city). Vercel resources are global — there is no region field to
 * correlate against — so edge components map to a display-only
 * "Edge (CODE)" service. Core platform components (Builds, CDN, Serverless
 * Functions, …) escalate to provider-wide; Dashboard and
 * integration/marketplace components are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.vercel-status.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.vercel-status.com",
};

/** "ARN1 - Stockholm, Sweden" → ARN1 */
const EDGE_REGION = /^([A-Z]{3}\d+) - /;

/** Core service components — an incident here affects all Vercel resources. */
const CORE_COMPONENTS = new Set([
  "Builds",
  "CDN",
  "Serverless Functions",
  "Edge Functions",
  "Domain Registration",
  "DNS",
  "API",
]);

function mapComponent(name: string): StatusComponentMapping | null {
  const edge = name.match(EDGE_REGION);
  if (edge?.[1]) return { services: [`Edge (${edge[1]})`] };
  if (CORE_COMPONENTS.has(name)) return { services: [name], providerWide: true };
  if (name === "Dashboard" || /integration|marketplace/i.test(name)) return null;
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

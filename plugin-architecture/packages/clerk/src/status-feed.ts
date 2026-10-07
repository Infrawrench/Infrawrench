/**
 * Clerk public status feed (https://status.clerk.com, verified 2026-10).
 * The page is hosted on incident.io, which emulates the Statuspage v2 API but
 * answers 404 for /incidents/unresolved.json, so this polls
 * /api/v2/incidents.json and keeps the unresolved incidents, the same
 * approach as the OpenAI and Infisical plugins. Incidents carry no
 * components in that feed, so each one is provider-wide; components are
 * mapped in case they appear (Dashboard-only and Billing incidents do not
 * affect the auth service an app depends on).
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.clerk.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.clerk.com",
};

const CORE = new Set([
  "Authentication & User",
  "Session management",
  "Platform API",
  "Multi-tenant authentication",
  "Machine authentication",
]);

function mapComponent(name: string): StatusComponentMapping | null {
  if (/^Dashboard/.test(name)) return null;
  return { services: [name], ...(CORE.has(name) ? { providerWide: true } : {}) };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

/**
 * Snowflake public status feed (Atlassian Statuspage, https://status.snowflake.com;
 * verified 2026-10 against `/api/v2/components.json`).
 *
 * Components are grouped by cloud region ("AWS - US West (Oregon)") and named
 * by feature ("Virtual Warehouses", "Databases, Tables, and Views", "Data
 * Loading and Unloading", ...), the same names in every region. Each feature
 * maps to one display service. Virtual Warehouses and Organization and
 * Account Management escalate to provider-wide: every query, listing and cost
 * read this plugin makes depends on them.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.snowflake.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.snowflake.com",
};

const PROVIDER_WIDE = new Set(["Virtual Warehouses", "Organization and Account Management"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  const feature = name.trim();
  // Region group headers are named "<Cloud> - <Region>".
  if (!feature || /^(AWS|Azure|GCP)\b/.test(feature)) return null;
  if (PROVIDER_WIDE.has(feature)) return { services: [feature], providerWide: true };
  return { services: [feature] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

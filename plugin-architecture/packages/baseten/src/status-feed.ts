/**
 * Baseten public status feed (Atlassian Statuspage, https://status.baseten.co,
 * verified 2026-10). Components are products, with no regions: "Dedicated
 * Inference", "Model APIs", "Training", "Model Management API", "Web
 * Application" and "Homepage and Docs". The management API and web app are
 * what every Baseten resource here depends on, so those count as
 * provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.baseten.co/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.baseten.co",
};

const PROVIDER_WIDE = new Set(["Model Management API", "Web Application"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "Homepage and Docs") return null;
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

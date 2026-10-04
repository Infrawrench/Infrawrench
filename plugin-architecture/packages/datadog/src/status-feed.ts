/**
 * Datadog public status feed (Atlassian Statuspage, https://status.datadoghq.com,
 * the US1 site's page; verified 2026-10 against `/api/v2/components.json`).
 *
 * Each Datadog site has its own status page, but a manifest carries one feed
 * and most accounts are on US1, so US1 is the one polled. Components are
 * Datadog products ("APM", "Log Management", "Monitors", …) and map onto
 * display services one to one. The web application and the monitor
 * evaluation pipeline escalate to provider-wide, since everything this plugin
 * shows depends on one or the other; the marketing site, the mobile app and
 * the package repositories are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.datadoghq.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.datadoghq.com",
};

const PROVIDER_WIDE = new Set(["Web Application", "Monitors", "Metrics and Infra Monitoring"]);
const IGNORED = new Set(["www.datadoghq.com", "Mobile Application", "Package Repositories"]);

function mapComponent(name: string): StatusComponentMapping | null {
  if (IGNORED.has(name)) return null;
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

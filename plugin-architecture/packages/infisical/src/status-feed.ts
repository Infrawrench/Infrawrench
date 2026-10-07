/**
 * Infisical public status feed (https://status.infisical.com, verified
 * 2026-10). The page is hosted on incident.io, which emulates the Atlassian
 * Statuspage v2 API but answers 404 for /incidents/unresolved.json, so this
 * polls /api/v2/incidents.json (recent history) and keeps the unresolved
 * incidents after parsing, the same approach as the OpenAI plugin.
 *
 * Components ("Secrets management", "PKI", "PAM", "Infisical Dedicated
 * Cloud", the CLI and Helm repositories) are listed twice, once per cloud
 * region, with identical names, so they cannot be mapped to US or EU; every
 * incident is treated as a service incident for the whole provider.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.infisical.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.infisical.com",
};

/** Distribution channels, not the service a connected account depends on. */
const IGNORED = /CLI repository|Helm repository/i;

function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (IGNORED.test(trimmed)) return null;
  return { services: [trimmed], providerWide: /Secrets management/i.test(trimmed) };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

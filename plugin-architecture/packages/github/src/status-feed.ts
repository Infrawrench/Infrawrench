/**
 * GitHub's public status feed (Atlassian Statuspage at
 * https://www.githubstatus.com; component list verified 2026-10 against
 * `/api/v2/components.json`). Components are GitHub products and map onto
 * the services cost rows are filed under, so an Actions incident lines up
 * with Actions spend. API Requests escalates to provider-wide, since every
 * listing and the cost collector depend on it.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.githubstatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.githubstatus.com",
};

const SERVICE_BY_COMPONENT: Record<string, string> = {
  Actions: "Actions",
  Packages: "Packages",
  Codespaces: "Codespaces",
  Copilot: "Copilot",
  "Copilot AI Model Providers": "Copilot",
  "Git Operations": "Git Operations",
  Webhooks: "Webhooks",
  Issues: "Issues",
  "Pull Requests": "Pull Requests",
  Pages: "Pages",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "API Requests") return { services: [name], providerWide: true };
  const service = SERVICE_BY_COMPONENT[name];
  return service ? { services: [service] } : null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

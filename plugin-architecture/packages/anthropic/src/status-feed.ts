/**
 * Anthropic public status feed (Atlassian Statuspage,
 * https://status.claude.com — verified 2026-08; status.anthropic.com 301s
 * there, so the moved host is used directly).
 *
 * Components: "Claude API (api.anthropic.com)" and "Claude Console
 * (platform.claude.com)" cover the API surfaces this plugin manages and
 * escalate to provider-wide. The consumer surfaces — "claude.ai",
 * "Claude Code", "Claude Cowork", "Claude for Government" — are not API
 * resources and are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.claude.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.claude.com",
};

function mapComponent(name: string): StatusComponentMapping | null {
  // API-side surfaces this plugin manages resources on.
  if (name.startsWith("Claude API") || name.startsWith("Claude Console")) {
    return { services: [name], providerWide: true };
  }
  // Consumer surfaces — not API resources.
  if (
    name === "claude.ai" ||
    name.startsWith("Claude Code") ||
    name.startsWith("Claude Cowork") ||
    name.startsWith("Claude for Government")
  ) {
    return null;
  }
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

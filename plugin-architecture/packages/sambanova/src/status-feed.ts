/**
 * SambaNova public status feed (Atlassian Statuspage,
 * https://status.sambanova.ai; verified 2026-10). Components are per model
 * ("gpt-oss-120b", "DeepSeek-V3.1", …) plus "SambaCloud API Gateway",
 * "SambaCloud Supported Models", "SambaCloud - Japan", "SambaCloud
 * Playground" and "SambaNova Developer Community". The gateway takes every
 * model down, so it escalates to provider-wide; the playground and
 * community site are not API surfaces.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.sambanova.ai/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.sambanova.ai",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (/playground|community/i.test(name)) return null;
  if (/api gateway|supported models/i.test(name)) {
    return { services: [name], providerWide: true };
  }
  return { services: [name], resourceTypes: ["sambanova-model"] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

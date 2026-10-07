/**
 * Cerebras Inference public status feed (Atlassian Statuspage,
 * https://status.cerebras.ai; verified 2026-10). Components are individual
 * models ("GPT-OSS-120B", "Qwen-3.8-27b") plus "Developer Console". Model
 * components scope to model resources; the console is not an API surface.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.cerebras.ai/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.cerebras.ai",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (/console/i.test(name)) return null;
  return { services: [name], resourceTypes: ["cerebras-model", "cerebras-endpoint"] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

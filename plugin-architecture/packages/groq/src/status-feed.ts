/**
 * Groq public status feed (incident.io emulating the Statuspage v2 API,
 * https://groqstatus.com — verified 2026-08).
 *
 * incident.io hosts 404 on /incidents/unresolved.json, so this fetches
 * /api/v2/incidents.json (full history) and filters to unresolved after
 * parsing. Incident objects carry no components — the parser marks them
 * provider-wide automatically. The component mapper is future-proofing:
 * components on this page are model ids ("openai/gpt-oss-120b") plus
 * "API" and "Website"; "Website" never affects API resources.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://groqstatus.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://groqstatus.com",
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (name === "Website") return null;
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  // The feed is full history — keep only active incidents; the host closes
  // cached rows that disappear from the parsed set.
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

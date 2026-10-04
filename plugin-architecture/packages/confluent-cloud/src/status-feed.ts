/**
 * Confluent Cloud public status feed (Atlassian Statuspage,
 * https://status.confluent.cloud; verified 2026-10 against
 * `/api/v2/components.json` and `/api/v2/incidents.json`).
 *
 * The page has a single component, "Confluent Cloud", so components say
 * nothing about scope. Incident titles do: "Elevated error rates in Azure
 * East US", "Connectivity degradation - AWS us-east-1", "Flink statements
 * degraded in GCP us-central1 region". The parser lifts the cloud region
 * out of the title and scopes the incident to it, matching the `region`
 * field every regional resource here carries (Confluent uses each cloud's own
 * region ids: `us-east-1`, `us-central1`, `eastus`). An incident whose title
 * names no region, or says "All Regions", stays provider-wide.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.confluent.cloud/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.confluent.cloud",
};

/** AWS (`us-east-1`) and GCP (`us-central1`, `europe-west3`) style ids. */
const DASHED_REGION =
  /\b((?:us|eu|ap|sa|ca|me|af|il|mx|asia|europe|northamerica|southamerica|australia|africa)-[a-z]+\d?(?:-\d+)?)\b/gi;
/** "Azure East US", "Azure Germany West Central region": Azure ids are the name, squashed. */
const AZURE_REGION =
  /\bAzure\s+((?:[A-Z][a-z]+|[A-Z]{2,}|\d)(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|\d))*)/g;
const AZURE_STOP = new Set(["region", "regions", "and", "multiple", "services"]);

/** Region ids named in an incident title. */
export function regionsInTitle(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(DASHED_REGION)) {
    const id = m[1]!.toLowerCase();
    // Must end in a digit to be a region rather than a word like "us-based".
    if (/\d$/.test(id)) out.add(id);
  }
  for (const m of title.matchAll(AZURE_REGION)) {
    const words: string[] = [];
    for (const w of m[1]!.split(/\s+/)) {
      if (AZURE_STOP.has(w.toLowerCase())) break;
      words.push(w);
    }
    if (words.length > 0) out.add(words.join("").toLowerCase());
  }
  return [...out];
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const incidents = parseStatuspageIncidents(body, {
    mapComponent: () => ({ services: ["Confluent Cloud"], providerWide: true }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
  return incidents.map((incident) => {
    if (/all regions/i.test(incident.title)) return incident;
    const regions = regionsInTitle(incident.title);
    if (regions.length === 0) return incident;
    return { ...incident, regions, providerWide: false };
  });
}

/**
 * Coralogix public status feed (Atlassian Statuspage, https://status.coralogix.com;
 * verified 2026-10 against `/api/v2/components.json`).
 *
 * The page groups the same components under one group per region (EU1, EU2,
 * US1, US2, US3, AP1, AP2, AP3), so a component name ("Ingestion - Logs
 * (Frequent Search)", "Alerts - Metrics", "API - External") says what broke
 * but not where. Incident titles name the region as a rule, so the region ids
 * found in the title are attached as the incident's regions, matching the
 * `region` the cost rows carry. The external API and sign-in escalate to
 * provider-wide, since everything this plugin shows goes through the one or
 * depends on the other. Component names use both a hyphen and an en dash as
 * separator, so both are normalised.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";
import { CORALOGIX_REGIONS } from "./regions.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.coralogix.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.coralogix.com",
};

const PROVIDER_WIDE = new Set([
  "API - External",
  "Open API - Fetch Data",
  "UI - Authentication / Login",
]);

function normalise(name: string): string {
  return name.replace(/\s+[–—-]\s+/g, " - ").trim();
}

function mapComponent(raw: string): StatusComponentMapping | null {
  const name = normalise(raw);
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return { services: [name] };
}

const REGION_PATTERN = new RegExp(
  `\\b(${CORALOGIX_REGIONS.map((r) => r.label).join("|")})\\b`,
  "gi",
);

export function parseStatusFeed(body: string): StatusIncident[] {
  const incidents = parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
  return incidents.map((incident) => {
    const found = new Set(incident.regions);
    for (const m of incident.title.matchAll(REGION_PATTERN)) {
      found.add(m[1]!.toLowerCase());
    }
    return { ...incident, regions: [...found] };
  });
}

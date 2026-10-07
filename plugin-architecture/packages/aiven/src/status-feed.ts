/**
 * Aiven's public status page (https://status.aiven.io, hosted on
 * incident.io, which serves a Statuspage-compatible API; verified 2026-10).
 * `/api/v2/incidents/unresolved.json` is not served (404), so the plugin reads
 * `/api/v2/incidents.json` and drops incidents resolved more than three days
 * ago. Incidents name no components (the page has a single "Aiven"
 * component), so each one is provider-wide; when the title or latest update
 * names an Aiven cloud such as `google-europe-west1` or `aws-eu-west-1`,
 * that cloud is added as a region, which is the `cloud` field services carry.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.aiven.io/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.aiven.io",
};

const MAX_RESOLVED_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CLOUD = /\b(?:aws|google|azure|do|upcloud)-[a-z]+(?:-[a-z]+)*-?\d+[a-z]?\b/gi;

export function parseStatusFeed(body: string, now: number = Date.now()): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent: (name) => ({ services: [name], providerWide: true }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  })
    .filter(
      (i) =>
        !(
          i.state === "resolved" &&
          i.resolvedAt &&
          now - Date.parse(i.resolvedAt) > MAX_RESOLVED_AGE_MS
        ),
    )
    .map((i) => {
      const clouds = new Set(
        [...`${i.title} ${i.lastUpdateText ?? ""}`.matchAll(CLOUD)].map((m) => m[0].toLowerCase()),
      );
      return clouds.size ? { ...i, regions: [...new Set([...i.regions, ...clouds])] } : i;
    });
}

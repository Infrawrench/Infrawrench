/**
 * Xata public status feed (incident.io emulating the Statuspage v2 API,
 * https://www.xatastatus.com: verified 2026-10).
 *
 * incident.io answers 404 on /incidents/unresolved.json, so this reads the
 * full /incidents.json history and keeps unresolved incidents. Components are
 * "Console", "Management APIs" and one "Database connectivity (<CLOUD>
 * <region>)" per data-plane region, e.g. "(AWS us-east-1)" or "(GCP
 * us-central1)". The region is emitted both bare and cloud-prefixed
 * ("us-east-1", "aws-us-east-1") so it matches however a branch's `region`
 * field spells it; the console and the API are what this plugin talks to, so
 * they escalate to provider-wide.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.xatastatus.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.xatastatus.com",
};

const CONNECTIVITY = /^Database connectivity \((\w+)\s+([a-z0-9-]+)\)$/i;

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  const m = CONNECTIVITY.exec(trimmed);
  if (m) {
    const cloud = m[1]!.toLowerCase();
    const region = m[2]!;
    return {
      regions: [region, `${cloud}-${region}`],
      services: ["Database connectivity"],
      resourceTypes: ["xata-branch"],
    };
  }
  return { services: [trimmed], providerWide: true };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  }).filter((incident) => incident.state !== "resolved" && !incident.resolvedAt);
}

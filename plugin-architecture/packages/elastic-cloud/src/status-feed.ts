/**
 * Elastic Cloud public status feed: an Atlassian Statuspage
 * (https://status.elastic.co, page "Elastic Cloud (Public)"; verified
 * 2026-10). `incidents/unresolved.json` answers 200 there, so the feed is
 * already filtered to open incidents.
 *
 * Components are named "<what>: <provider> <region>" or
 * "<provider> <what>: <region>", e.g. "AWS EC2 Health: us-east-1",
 * "Elasticsearch connectivity: GCP us-east4",
 * "Kibana connectivity: Azure azure-centralindia". The region is the last
 * token; it is turned into the ids the Cloud API writes into a deployment's
 * or project's `region` field (`aws-us-east-1`, `gcp-us-east4`,
 * `azure-centralindia`), plus the bare AWS form, which older AWS regions
 * still use for hosted deployments (`us-east-1`).
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.elastic.co/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.elastic.co",
};

const REGION_SLUG = /^[a-z0-9-]+$/;

/** Region ids a status component's trailing region token stands for. */
export function regionIdsForComponent(name: string): string[] {
  const tokens = name.trim().split(/\s+/);
  const last = (tokens[tokens.length - 1] ?? "").toLowerCase();
  if (!last || !REGION_SLUG.test(last) || !/[\d-]/.test(last)) return [];
  const lower = name.toLowerCase();
  if (last.startsWith("azure-")) return [last];
  if (/\bazure\b/.test(lower)) return [`azure-${last}`];
  if (/\bgcp\b/.test(lower)) return [`gcp-${last}`];
  if (/\baws\b|\bs3\b|\bec2\b/.test(lower)) return [`aws-${last}`, last];
  return [last];
}

function mapComponent(name: string): StatusComponentMapping | null {
  const regions = regionIdsForComponent(name);
  if (regions.length > 0) return { regions };
  // "Cloud console", "Global services", "Cloud Connect Health": not tied to
  // one region, so every resource is in scope.
  if (/console|global|api|billing|connect/i.test(name)) return { providerWide: true };
  return null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

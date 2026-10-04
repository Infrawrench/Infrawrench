/**
 * Grafana Cloud public status feed (Atlassian Statuspage at
 * https://status.grafana.com, verified 2026-10 against `/api/v2/components.json`).
 *
 * Components are named after the cloud region and, for the finer ones, the
 * subsystem: `AWS Australia - prod-ap-southeast-2: Querying`. The region slug
 * in that name is exactly the `regionSlug` the Cloud API reports on a stack,
 * which is what a stack's `region` field holds, so an incident lands on the
 * stacks in that region and nowhere else. `Grafana.com` (the Cloud API and
 * portal this plugin talks to for everything) is provider-wide; support and
 * the website are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.grafana.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.grafana.com",
};

const IGNORED = new Set(["Support Tickets", "Grafana Website", "Community Forums", "Docs"]);
const PROVIDER_WIDE = new Set(["Grafana.com"]);
const REGION_SLUG = /\b(prod-[a-z]+-[a-z]+-\d+)\b/;

export function mapComponent(name: string): StatusComponentMapping | null {
  if (IGNORED.has(name)) return null;
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  const region = REGION_SLUG.exec(name)?.[1];
  const colon = name.indexOf(": ");
  const service = colon >= 0 ? name.slice(colon + 2) : name;
  if (region) return { regions: [region], services: [service], resourceTypes: ["stack"] };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

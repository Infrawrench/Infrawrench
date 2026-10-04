/**
 * New Relic public status feed (Atlassian Statuspage, https://status.newrelic.com;
 * verified 2026-10 against `/api/v2/components.json`).
 *
 * Components are named `<Product> : <Region>` ("APM : US", "NRQL : Europe",
 * "Alerts : JP"). The region suffix is dropped so each product maps to one
 * display service. NRQL and Alerts escalate to provider-wide, since every
 * chart, usage figure and alert this plugin shows depends on them.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.newrelic.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.newrelic.com",
};

const PROVIDER_WIDE = new Set(["NRQL", "Alerts"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  const product = name.split(" : ")[0]?.trim() ?? "";
  if (!product || product === "isNewUser") return null;
  if (PROVIDER_WIDE.has(product)) return { services: [product], providerWide: true };
  return { services: [product] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

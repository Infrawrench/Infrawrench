/**
 * Spacelift's public status page (Atlassian Statuspage at
 * https://spacelift.statuspage.io; components verified 2026-10).
 *
 * The GraphQL API escalates to provider-wide: every stack, run and context
 * operation goes through it. "Event processing" (VCS webhooks into runs) and
 * "Public workers" map to the types they affect. Platform UI, Self Hosted,
 * the website, Slack and the AWS / GCP / GitHub / Stripe groups are ignored:
 * an upstream incident matters through the Spacelift component it degrades.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://spacelift.statuspage.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://spacelift.statuspage.io",
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  if (n === "GraphQL API") return { services: [n], providerWide: true };
  if (n === "Event processing") return { services: [n], resourceTypes: ["stack", "run"] };
  if (n === "Public workers") return { services: [n], resourceTypes: ["run", "stack"] };
  return null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

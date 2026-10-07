/**
 * Pulumi's public status page (Atlassian Statuspage at
 * https://status.pulumi.com; components verified 2026-10 against
 * `/api/v2/components.json`).
 *
 * The API escalates to provider-wide: every stack operation, deployment and
 * environment open goes through it. Deployments, ESC and Insights map to the
 * resource types they serve. The console, Registry, Neo, docs and the "Third
 * Party Services" group (AWS, GitHub, GitLab, Docker, Stripe, Mailchimp) are
 * ignored: an upstream incident matters through the Pulumi component it
 * degrades, and that component reports it.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.pulumi.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.pulumi.com",
};

const COMPONENTS: Record<string, string[]> = {
  Deployments: ["deployment", "stack"],
  ESC: ["environment"],
  Insights: ["organization"],
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  if (n === "API") return { services: [n], providerWide: true };
  const types = COMPONENTS[n];
  return types ? { services: [n], resourceTypes: types } : null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

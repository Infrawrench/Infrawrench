/**
 * Convex public status feed (Atlassian Statuspage, https://status.convex.dev:
 * verified 2026-10).
 *
 * Components are plan tiers, not regions: a "Live Traffic" group and a
 * "Development Services" group, each holding "Free & Starter",
 * "Professional" and "Business", plus "AI Gateway" and "convex.dev website".
 * Statuspage reports leaf components by name only, so a tier could belong to
 * either group; tiers are therefore read as provider-wide (every deployment
 * runs on one of them). AI Gateway maps to deployments as a service, and the
 * marketing website never affects infrastructure.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.convex.dev/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.convex.dev",
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (/website/i.test(trimmed)) return null;
  if (trimmed === "AI Gateway") {
    return { services: [trimmed], resourceTypes: ["convex-deployment"] };
  }
  return { services: [trimmed], providerWide: true };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

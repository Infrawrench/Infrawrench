/**
 * Upstash status page (https://status.upstash.com, Atlassian Statuspage;
 * components checked 2026-10 against `/api/v2/components.json`).
 *
 * Components are grouped by product with one child per region, and incidents
 * name only the leaf, whose spelling tells the product apart:
 *
 * - "N. Virginia, USA (us-east-1)": Redis Global, region in brackets
 * - "AWS US-EAST-1", "GCP US-CENTRAL-1": Redis Regional (legacy)
 * - "AWS - EU-WEST-1", "GCP - US-CENTRAL1": Vector
 * - "EU-CENTRAL-1", "US-EAST-1": QStash
 *
 * Group names ("Redis Global", "Vector", "QStash") map to the product, the
 * Upstash Console escalates to provider-wide, and Context7 and Box (other
 * Upstash products this plugin does not manage) are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.upstash.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.upstash.com",
};

/** "US-CENTRAL-1" (Redis spelling of a GCP region) to "us-central1". */
function gcpRegion(raw: string): string {
  return raw.toLowerCase().replace(/-(\d+)$/, "$1");
}

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  if (/^context7|^box$/i.test(n)) return null;
  if (/console/i.test(n)) return { services: [n], providerWide: true };
  if (/^redis (global|regional)$/i.test(n)) return { services: [n], resourceTypes: [T.redis] };
  if (/^vector$/i.test(n)) return { services: [n], resourceTypes: [T.vector] };
  if (/^qstash$/i.test(n))
    return { services: [n], resourceTypes: [T.qstash, T.schedule, T.queue, T.urlGroup] };
  if (/^search$/i.test(n)) return { services: [n], resourceTypes: [T.search] };
  const bracket = /\(([a-z0-9-]+)\)\s*$/i.exec(n);
  if (bracket)
    return { services: ["Redis"], regions: [bracket[1]!.toLowerCase()], resourceTypes: [T.redis] };
  const vector = /^(AWS|GCP) - (.+)$/i.exec(n);
  if (vector)
    return { services: ["Vector"], regions: [vector[2]!.toLowerCase()], resourceTypes: [T.vector] };
  const regional = /^(AWS|GCP) (.+)$/i.exec(n);
  if (regional) {
    const region =
      regional[1]!.toUpperCase() === "GCP" ? gcpRegion(regional[2]!) : regional[2]!.toLowerCase();
    return { services: ["Redis"], regions: [region], resourceTypes: [T.redis] };
  }
  if (/^[A-Z]{2}-[A-Z]+-\d$/.test(n)) {
    return {
      services: ["QStash"],
      regions: [n.toLowerCase()],
      resourceTypes: [T.qstash, T.schedule, T.queue, T.urlGroup],
    };
  }
  return { services: [n] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

/**
 * Linode's public status page (Atlassian Statuspage, https://status.linode.com;
 * component tree checked 2026-10-04).
 *
 * Components are product groups whose children are named
 * "<REGION-CODE> (<City>) <Product>", e.g. "US-East (Newark) Block Storage",
 * or just "<REGION-CODE> (<City>)" under Regions and Metadata Service. The
 * code before the parenthesis is the region id in upper case, with one
 * exception: Tokyo 2 is `ap-northeast` but its components say
 * "AP-Northeast-2". Distributed sites (ZA-JNB, NZ-AKL, ...) follow the same
 * rule.
 */

import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.linode.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.linode.com",
};

const REGION_ALIASES: Record<string, string> = { "ap-northeast-2": "ap-northeast" };

const PRODUCT_TYPES: Array<[RegExp, string, string[]]> = [
  [/block storage$/i, "Block Storage", ["volume"]],
  [/nodebalancers?$/i, "NodeBalancers", ["nodebalancer"]],
  [/backups$/i, "Backups", ["linode"]],
  [/object storage$/i, "Object Storage", ["bucket"]],
  [/linode kubernetes engine$/i, "Linode Kubernetes Engine", ["lke-cluster", "lke-node-pool"]],
];

export function regionFromComponent(name: string): string | null {
  const m = /^([A-Z]{2}(?:-[A-Z0-9]+)+)\s*\(/i.exec(name.trim());
  if (!m) return null;
  const code = m[1]!.toLowerCase();
  return REGION_ALIASES[code] ?? code;
}

function mapComponent(name: string): StatusComponentMapping | null {
  const region = regionFromComponent(name);
  for (const [pattern, service, types] of PRODUCT_TYPES) {
    if (pattern.test(name)) {
      return {
        services: [service],
        resourceTypes: types,
        ...(region ? { regions: [region] } : {}),
      };
    }
  }
  if (region) return { regions: [region] };
  switch (name) {
    case "Cloud Manager and API":
      return { services: [name], providerWide: true };
    case "Hosted DNS Service":
      return { services: [name], resourceTypes: ["domain", "domain-record"] };
    case "Managed Databases":
      return { services: [name], resourceTypes: ["database"] };
    case "Linode.com":
    case "Longview":
      return null;
    default:
      return { services: [name] };
  }
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

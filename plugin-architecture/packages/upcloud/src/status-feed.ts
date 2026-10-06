/**
 * UpCloud's status page (https://status.upcloud.com) is Atlassian Statuspage
 * (components checked 2026-10-06). Components are named
 * "<ZONE>: <Product>" ("DE-FRA1: Cloud Servers", "FI-HEL2: Managed
 * Databases"), with a few typos UpCloud has published ("US:CHI1",
 * "FI_HEL1"); Managed Object Storage is per region ("EUROPE-1: Managed
 * Object Storage", also "SG-SIN1 - Singapore - APAC-1: ..."). The zone
 * lowercased is the plugin's `zone`; object storage regions are lowercased
 * to the API's region names.
 */

import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.upcloud.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.upcloud.com",
};

const PRODUCTS: Array<[RegExp, string[]]> = [
  [/cloud servers/i, ["server"]],
  [/storage backends/i, ["storage", "backup", "template"]],
  [/network connections|nat gateways|vpn gateways/i, ["network", "router", "floating-ip"]],
  [/managed databases/i, ["database", "database-user", "database-db"]],
  [/managed load balancer/i, ["load-balancer"]],
  [/managed kubernetes/i, ["kubernetes-cluster", "node-group"]],
  [/managed object storage/i, ["object-storage", "bucket", "object-storage-user"]],
];

export function zoneOf(name: string): string | null {
  const m = /^([A-Z]{2})[-:_]([A-Z]{3}\d)\b/i.exec(name.trim());
  return m ? `${m[1]}-${m[2]}`.toLowerCase() : null;
}

export function mapComponent(name: string): StatusComponentMapping | null {
  const clean = name.replace(/ /g, " ").trim();
  const product = clean.includes(":") ? clean.slice(clean.lastIndexOf(":") + 1).trim() : "";
  const regionMatch = /\b(EUROPE|US|APAC)-(\d)\b/i.exec(clean);
  const zone = zoneOf(clean);
  for (const [re, types] of PRODUCTS) {
    if (re.test(product || clean)) {
      const region =
        /object storage/i.test(clean) && regionMatch
          ? `${regionMatch[1]}-${regionMatch[2]}`.toLowerCase()
          : zone;
      return {
        services: [product || clean],
        resourceTypes: types,
        ...(region ? { regions: [region] } : {}),
      };
    }
  }
  if (zone) return { regions: [zone], services: [product || clean] };
  if (/^api$/i.test(clean) || /control panel/i.test(clean))
    return { services: [clean], providerWide: true };
  if (/website/i.test(clean)) return null;
  return { services: [clean] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: "https://status.upcloud.com",
  });
}

/**
 * Fly.io public status feed (Atlassian Statuspage, https://status.flyio.net —
 * verified 2026-08; status.fly.io 301s there).
 *
 * Region components are named "AMS - Amsterdam, Netherlands" (IATA prefix),
 * with per-region control-plane components like "Management Plane - ORD".
 * The IATA code lowercased is exactly the region code Fly resources carry in
 * their `region` field.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.flyio.net/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.flyio.net",
};

/** "AMS - Amsterdam, Netherlands" → ams */
const REGION_PREFIX = /^([A-Z]{3}) - /;
/** "Management Plane - ORD" → ord */
const MANAGEMENT_PLANE = /^Management Plane - ([A-Z]{3})$/;

const SERVICE_TYPES: Record<string, string[]> = {
  "Machines API": ["machine"],
  Machines: ["machine"],
  Volumes: ["volume"],
  Certificates: ["certificate"],
  "Anycast Proxy": ["app", "ip-allocation"],
};

function mapComponent(name: string): StatusComponentMapping | null {
  const region = name.match(REGION_PREFIX);
  if (region?.[1]) return { regions: [region[1].toLowerCase()] };
  const plane = name.match(MANAGEMENT_PLANE);
  if (plane?.[1]) return { regions: [plane[1].toLowerCase()], services: ["Management Plane"] };
  const types = SERVICE_TYPES[name];
  if (types) return { services: [name], resourceTypes: types };
  if (name === "API" || name === "GraphQL API" || name === "Fly.io Platform") {
    return { services: [name], providerWide: true };
  }
  // Deploy tooling, remote builders, dashboard, docs, WireGuard gateways…
  // real services, but not scoped to any resource — keep for display.
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

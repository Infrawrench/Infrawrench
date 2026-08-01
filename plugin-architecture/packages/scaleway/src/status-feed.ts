/**
 * Scaleway public status feed (Atlassian Statuspage,
 * https://status.scaleway.com — verified 2026-08).
 *
 * AZ components are lowercase zone slugs (fr-par-1/2/3, nl-ams-1/2,
 * pl-waw-1/2/3). Scaleway resources store either a zone ("fr-par-1", e.g.
 * instances) or a region ("fr-par", e.g. managed databases and object
 * storage), so a zone component maps to both the zone and its parent region.
 * Dedibox datacenter components (DC2, DC3, DC5, AMS1, …) belong to the
 * dedicated-server line this plugin does not cover and are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.scaleway.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.scaleway.com",
};

/** Zone slug components: fr-par-1, nl-ams-2, pl-waw-3, … */
const ZONE_COMPONENT = /^[a-z]{2}-[a-z]{3}-\d$/;

/** Dedibox datacenters (uppercase): DC2, DC3, DC5, AMS1, … */
const DEDIBOX_DC = /^(?:DC|AMS)\d+$/;

function mapComponent(name: string): StatusComponentMapping | null {
  if (ZONE_COMPONENT.test(name)) {
    // Emit both the zone and its parent region — resources carry either.
    return { regions: [name, name.replace(/-\d$/, "")] };
  }
  if (DEDIBOX_DC.test(name)) return null;
  if (name === "API" || name === "Console") {
    return { services: [name], providerWide: true };
  }
  // Product components: "Instances", "Kubernetes", "Object Storage", …
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

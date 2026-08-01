/**
 * DigitalOcean public status feed (Atlassian Statuspage,
 * https://status.digitalocean.com — verified 2026-08).
 *
 * Component naming on this page is product-group → region children:
 * "Droplets" has children "AMS3", "NYC1", … so a region component's name is
 * the uppercase region slug. Region components repeat across product groups,
 * which is fine here — "AMS3" means the ams3 region regardless of which
 * product group it sits under. App Platform children use city names instead
 * of slugs, so those are mapped explicitly.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.digitalocean.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.digitalocean.com",
};

/** Uppercase region slug components: AMS3, NYC1, SFO2, US-EAST-VA-1-style. */
const REGION_COMPONENT = /^[A-Z]{3}\d$/;

/** App Platform children are city names, not slugs. */
const CITY_REGIONS: Record<string, string[]> = {
  Amsterdam: ["ams3"],
  Atlanta: ["atl1"],
  Bangalore: ["blr1"],
  Frankfurt: ["fra1"],
  London: ["lon1"],
  "New York": ["nyc1", "nyc2", "nyc3"],
  "San Francisco": ["sfo2", "sfo3"],
  Singapore: ["sgp1"],
  Sydney: ["syd1"],
  Toronto: ["tor1"],
};

const PRODUCT_TYPES: Record<string, string[]> = {
  Droplets: ["droplet"],
  Kubernetes: ["doks-cluster"],
  "Managed Databases": ["managed-database"],
  "Container Registry": ["container-registry"],
  Spaces: ["spaces"],
  Volumes: ["volume"],
  Networking: ["vpc", "reserved-ip", "domain", "dns-record"],
  DNS: ["domain", "dns-record"],
  "GenAI Platform": ["gen-ai-agent", "gen-ai-knowledge-base", "gen-ai-model-router"],
};

function mapComponent(name: string): StatusComponentMapping | null {
  if (REGION_COMPONENT.test(name)) return { regions: [name.toLowerCase()] };
  const cityRegions = CITY_REGIONS[name];
  if (cityRegions) return { regions: cityRegions };
  const types = PRODUCT_TYPES[name];
  if (types) return { services: [name], resourceTypes: types };
  // Control-plane components take everything down for practical purposes.
  if (name === "API" || name === "Cloud Control Panel") {
    return { services: [name], providerWide: true };
  }
  // "Global" children and components like "Billing"/"Support Center" don't
  // scope to infrastructure — keep the incident but let other components
  // (or provider-wide fallback) decide the blast radius.
  if (name === "Global") return { services: [] };
  if (name === "Billing" || name === "Support Center" || name === "Community") return null;
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

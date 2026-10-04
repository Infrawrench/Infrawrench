/**
 * Crusoe Cloud public status feed (Atlassian Statuspage,
 * https://status.crusoecloud.com, verified 2026-10).
 *
 * Region components are bare region names (`us-east1`, `us-northcentral1`,
 * `eu-iceland1`, …) grouped under "GPU Virtual Machines", while resources
 * store a zone (`us-northcentral1-a`), so a region component maps to the
 * region and its lettered zones. "API" and "UI" are provider-wide; every
 * other component is a product ("Crusoe Managed Kubernetes (CMK)", "Shared
 * Disks", "VPC Networking", "Serverless Inference", …).
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.crusoecloud.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.crusoecloud.com",
};

const REGION_COMPONENT = /^[a-z]{2}-[a-z]+\d+$/;

export function mapComponent(name: string): StatusComponentMapping | null {
  if (REGION_COMPONENT.test(name)) {
    return { regions: [name, `${name}-a`, `${name}-b`, `${name}-c`] };
  }
  if (name === "API" || name === "UI") return { services: [name], providerWide: true };
  return { services: [name] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

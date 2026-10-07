/**
 * Astra service health (https://status.astra.datastax.com, Atlassian
 * Statuspage; the old status.datastax.com page is inactive). Verified 2026-10.
 * Component groups: "Astra" (Astra Portal, Astra Serverless DB, Astra Classic
 * DB, Astra Streaming), "AWS" (children named "AWS us-east-1"…), "Azure"
 * (children named by bare region: "westus2", "eastus2"…) and "GCP" (children
 * named after Google Cloud services, not regions). Astra stores database
 * regions in the same spelling (`us-east-1`, `westus2`, `us-east1`), so AWS
 * and Azure components map straight onto the `region` field.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

const STATUS_PAGE = "https://status.astra.datastax.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/api/v2/incidents.json`,
  format: "statuspage-v2",
  statusPageUrl: STATUS_PAGE,
};

const AZURE_REGION = /^[a-z]+[a-z0-9]*\d?$/;

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  if (n === "Astra Portal") return { services: [n], providerWide: true };
  if (n === "Astra Serverless DB") {
    return { services: [n], resourceTypes: [T.database, T.region, T.keyspace, T.collection] };
  }
  if (n === "Astra Streaming") return { services: [n], resourceTypes: [T.tenant, T.cdc] };
  if (n === "Astra Classic DB") return null;
  const aws = /^AWS\s+([a-z]{2}-[a-z]+-\d)$/i.exec(n);
  if (aws) return { regions: [aws[1]!.toLowerCase()], services: [n] };
  if (/^[a-z]{2}-[a-z]+-\d$/.test(n)) return { regions: [n], services: [`AWS ${n}`] };
  if (n.startsWith("Google Cloud Platform")) {
    return { services: [n], resourceTypes: [T.database, T.region, T.tenant] };
  }
  if (AZURE_REGION.test(n)) return { regions: [n], services: [`Azure ${n}`] };
  return { services: [n] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const all = parseStatuspageIncidents(body, { mapComponent, statusPageUrl: STATUS_PAGE });
  // incidents.json carries history; keep what is open or resolved in the last two weeks.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return all.filter((i) => !i.resolvedAt || Date.parse(i.resolvedAt) >= cutoff);
}

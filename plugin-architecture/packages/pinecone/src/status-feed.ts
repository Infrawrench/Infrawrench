/**
 * Pinecone public status feed (Atlassian Statuspage, https://status.pinecone.io,
 * verified 2026-10). Components:
 *
 * - "Serverless Indexes" group: one component per region, named
 *   `<Cloud> <region>` ("AWS us-east-1", "GCP europe-west4", "Azure eastus2").
 *   These map to the `region` field serverless indexes carry.
 * - "Pod Indexes" group: one component per pod environment ("us-east1-gcp",
 *   "us-west1-gcp-free", "gcp-starter"), the `environment` field of pod indexes.
 * - "Index Management" (the control plane) and "Console": provider-wide.
 * - "Inference" and "Assistant": scoped to their own resource types.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.pinecone.io/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.pinecone.io",
};

const SERVERLESS = /^(AWS|GCP|Azure)\s+([a-z0-9-]+)$/i;

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (trimmed === "Index Management" || trimmed === "Console") {
    return { services: [trimmed], providerWide: true };
  }
  if (trimmed === "Assistant") return { services: ["Assistant"], resourceTypes: ["assistant"] };
  if (trimmed === "Inference") return { services: ["Inference"], resourceTypes: ["index"] };
  if (trimmed === "Serverless Indexes" || trimmed === "Pod Indexes") {
    return { services: [trimmed], resourceTypes: ["index", "backup", "collection"] };
  }
  const serverless = SERVERLESS.exec(trimmed);
  if (serverless) {
    return {
      services: ["Serverless Indexes"],
      regions: [serverless[2]!.toLowerCase()],
      resourceTypes: ["index", "backup", "backup-schedule", "restore-job"],
    };
  }
  // Pod environments are slugs like us-east1-gcp or gcp-starter.
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(trimmed)) {
    return {
      services: ["Pod Indexes"],
      regions: [trimmed],
      resourceTypes: ["index", "collection"],
    };
  }
  return { services: [trimmed] };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

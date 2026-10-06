/**
 * Bitbucket Cloud's public status page (Atlassian Statuspage at
 * https://bitbucket.status.atlassian.com; components verified 2026-10 from
 * `/api/v2/components.json`: Website, API, Git via SSH, Git via HTTPS,
 * Authentication and user management, Webhooks, Source downloads, Pipelines,
 * Git LFS, Email delivery, Purchasing & Licensing, Signup, Packages).
 * Components map onto services and the resource types they touch; API,
 * Website and authentication outages are provider-wide because every listing
 * depends on them. Purchasing, signup and email are ignored.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://bitbucket.status.atlassian.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://bitbucket.status.atlassian.com",
};

const BY_COMPONENT: Record<string, StatusComponentMapping> = {
  Pipelines: {
    services: ["Pipelines"],
    resourceTypes: ["pipeline", "pipeline-schedule", "runner", "environment", "pipeline-cache"],
  },
  Webhooks: { services: ["Webhooks"], resourceTypes: ["repository-webhook", "workspace-webhook"] },
  "Git via SSH": {
    services: ["Git"],
    resourceTypes: ["repository", "deploy-key", "project-deploy-key"],
  },
  "Git via HTTPS": { services: ["Git"], resourceTypes: ["repository"] },
  "Git LFS": { services: ["Git LFS"], resourceTypes: ["repository"] },
  "Source downloads": { services: ["Source downloads"], resourceTypes: ["repository"] },
  Packages: { services: ["Packages"] },
};

const PROVIDER_WIDE = new Set(["API", "Website", "Authentication and user management"]);

export function mapComponent(name: string): StatusComponentMapping | null {
  if (PROVIDER_WIDE.has(name)) return { services: [name], providerWide: true };
  return BY_COMPONENT[name] ?? null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

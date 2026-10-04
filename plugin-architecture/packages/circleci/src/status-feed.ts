/**
 * CircleCI public status feed (Atlassian Statuspage, https://status.circleci.com;
 * component list verified 2026-10 against `/api/v2/components.json`).
 *
 * Only CircleCI's own components map: the job executors, pipelines and
 * workflows, runner, Insights and billing. The API and the web app escalate
 * to provider-wide, since every listing depends on them. The "CircleCI
 * Dependencies" and "Upstream Services" groups (AWS, Google Cloud, GitHub,
 * Bitbucket, GitLab, Docker Hub, mailgun, Auth0, AI providers…) are ignored:
 * an upstream incident only matters through the CircleCI component it
 * degrades, and that component reports it.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.circleci.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.circleci.com",
};

const PROVIDER_WIDE = new Set(["CircleCI API", "CircleCI UI"]);

const COMPONENTS: Record<string, string[] | undefined> = {
  "Docker Jobs": ["pipeline", "workflow"],
  "Machine Jobs": ["pipeline", "workflow"],
  "macOS Jobs": ["pipeline", "workflow"],
  "Windows Jobs": ["pipeline", "workflow"],
  "Pipelines & Workflows": ["pipeline", "workflow", "schedule", "trigger"],
  Runner: ["runner-resource-class", "runner"],
  "CircleCI Insights": ["organization", "project", "workflow"],
  Artifacts: undefined,
  "CircleCI Webhooks": ["trigger"],
  "CircleCI Releases": undefined,
  "Notifications & Status Updates": undefined,
  "Billing & Account": ["organization"],
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (PROVIDER_WIDE.has(trimmed)) return { services: [trimmed], providerWide: true };
  if (!(trimmed in COMPONENTS)) return null;
  const resourceTypes = COMPONENTS[trimmed];
  return { services: [trimmed], ...(resourceTypes ? { resourceTypes } : {}) };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

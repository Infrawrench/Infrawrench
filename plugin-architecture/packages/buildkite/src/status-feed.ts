/**
 * Buildkite public status feed (Atlassian Statuspage at
 * https://www.buildkitestatus.com; component list verified 2026-10 against
 * `/api/v2/components.json`).
 *
 * Statuspage hands the mapper component names only, and Buildkite reuses some
 * of them across groups ("REST API" and "Web" appear under Test Engine and
 * Package Registries too), so an ambiguous name maps to its widest meaning.
 * The REST API, the web app and the Agent API escalate to provider-wide: every
 * listing, and every agent's connection, depends on them. Third-party (AWS),
 * SCM provider, notification, package registry, MCP and docs components are
 * ignored; an upstream incident matters through the Buildkite component it
 * degrades, and that component reports it.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://www.buildkitestatus.com/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://www.buildkitestatus.com",
};

const PROVIDER_WIDE = new Set(["REST API", "Rest API", "Web", "Agent API"]);

const COMPONENTS: Record<string, string[]> = {
  "Job Queue": ["build", "job", "agent", "queue"],
  "Hosted Agents": ["queue", "agent", "build", "job"],
  "Linux (AMD64)": ["queue", "agent", "build", "job"],
  "Linux (ARM64)": ["queue", "agent", "build", "job"],
  MacOS: ["queue", "agent", "build", "job"],
  "Windows (AMD64)": ["queue", "agent", "build", "job"],
  "SCM Integrations": ["pipeline", "build", "schedule"],
  Ingestion: ["test-suite", "test"],
};

export function mapComponent(name: string): StatusComponentMapping | null {
  const trimmed = name.trim();
  if (PROVIDER_WIDE.has(trimmed)) return { services: [trimmed], providerWide: true };
  const resourceTypes = COMPONENTS[trimmed];
  if (!resourceTypes) return null;
  return { services: [trimmed], resourceTypes };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  });
}

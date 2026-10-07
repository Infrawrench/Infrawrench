/**
 * HashiCorp's public status page (https://status.hashicorp.com, verified
 * 2026-10) serves a Statuspage-compatible `GET /api/v2/incidents.json`;
 * `/incidents/unresolved.json` 404s and incidents carry no components, so the
 * parser would read every incident (HCP Terraform, Boundary, releases…) as
 * provider-wide. Only incidents whose title names Vault, and not Vault Radar
 * (a separate scanning product), are kept. The page covers HCP Vault
 * Dedicated only: a self-hosted cluster is never affected by these.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.hashicorp.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.hashicorp.com",
};

export function isVaultIncident(title: string): boolean {
  return /\bvault\b/i.test(title) && !/\bradar\b/i.test(title);
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent: (name) => ({ services: [name] }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  })
    .filter((i) => isVaultIncident(i.title))
    .map((i) => ({ ...i, services: ["HCP Vault"] }));
}

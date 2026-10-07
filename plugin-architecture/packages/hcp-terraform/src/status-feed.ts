/**
 * HashiCorp's public status page (incident.io at https://status.hashicorp.com,
 * verified 2026-10). It covers every HashiCorp product, its incidents carry no
 * components (the component list has one "HCP Terraform" entry, but incidents
 * do not reference it), and incident.io 404s on `unresolved.json`, so this
 * reads `incidents.json`, keeps unresolved incidents whose title names
 * Terraform, and drops ones about the public registry or a provider release
 * (`Terraform AWS Provider v6...`), which do not touch an HCP Terraform
 * organization. Terraform Enterprise installs are self-hosted and have no
 * public status; their incidents would still show here, which is harmless.
 */
import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.hashicorp.com/api/v2/incidents.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.hashicorp.com",
};

/** True for an incident title that concerns HCP Terraform itself. */
export function isTerraformIncident(title: string): boolean {
  if (!/terraform/i.test(title)) return false;
  if (/registry/i.test(title)) return false;
  if (/provider\s+v?\d/i.test(title)) return false;
  return true;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as { incidents?: Array<{ name?: string }> };
  const incidents = (parsed.incidents ?? []).filter((i) => isTerraformIncident(i.name ?? ""));
  return parseStatuspageIncidents(JSON.stringify({ ...parsed, incidents }), {
    mapComponent: () => ({ services: ["HCP Terraform"], providerWide: true }),
    statusPageUrl: statusFeed.statusPageUrl ?? statusFeed.url,
  })
    .filter((i) => i.state !== "resolved" && !i.resolvedAt)
    .map((i) => ({
      ...i,
      services: i.services.length > 0 ? i.services : ["HCP Terraform"],
      providerWide: true,
    }));
}

/**
 * Provider status correlation contract — "is it me or is it them?".
 *
 * Wire types for `GET /api/org/{orgId}/status-incidents`, shared by every
 * surface that renders the incident banner or the Changes-page overlap
 * section (web, desktop, mobile, CLI). The server half lives in server-core
 * `status/match.ts`; keeping the response shape here means the two ends of
 * the wire cannot drift apart silently, same as `resource-changes.ts`.
 */

import type { CloudFetch } from "./fetch";

export type ProviderIncidentImpact = "maintenance" | "minor" | "major" | "critical";
export type ProviderIncidentState = "investigating" | "identified" | "monitoring" | "resolved";

/** A resource of yours that a provider incident overlaps. */
export interface ProviderIncidentResourceSample {
  id: string;
  displayName: string;
  resourceTypeId: string;
  /** The resource's region field, when it has one. */
  region?: string | null;
}

/**
 * One provider incident correlated against the org's resources — as returned
 * by `GET /api/org/{orgId}/status-incidents`. Active incidents come first
 * (most severe first), then incidents resolved within the requested window.
 */
export interface OrgStatusIncident {
  id: string;
  pluginId: string;
  /** Provider display name, e.g. "DigitalOcean". */
  pluginName: string;
  title: string;
  state: ProviderIncidentState;
  impact: ProviderIncidentImpact;
  /** Deep link to the provider's incident page or status page. */
  url?: string | null;
  startedAt: string;
  resolvedAt?: string | null;
  lastUpdateAt?: string | null;
  lastUpdateText?: string | null;
  /** Plugin-native region ids the provider reports as affected. */
  regions: string[];
  /** Human-readable affected provider services/products. */
  services: string[];
  /** True when the incident affects the provider as a whole. */
  providerWide: boolean;
  /** How many of the org's resources the incident overlaps. */
  affectedResourceCount: number;
  /** The subset of `regions` where the org actually holds resources. */
  affectedRegions: string[];
  /** Up to five of the overlapped resources, for display. */
  sampleResources: ProviderIncidentResourceSample[];
  /**
   * Resource changes recorded on this plugin during the incident window —
   * the "these N changes happened during an incident" correlation for the
   * Changes page.
   */
  overlappingChangeCount: number;
}

export interface OrgStatusIncidentsResponse {
  incidents: OrgStatusIncident[];
}

/** Incidents currently overlapping the org, active first, most severe first. */
export async function fetchOrgStatusIncidents(
  api: CloudFetch,
  orgId: string,
): Promise<OrgStatusIncidentsResponse> {
  const result = await api.org<OrgStatusIncidentsResponse>(orgId, "/status-incidents");
  return result ?? { incidents: [] };
}

const IMPACT_ORDER: Record<ProviderIncidentImpact, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  maintenance: 3,
};

/** Sort comparator: active before resolved, then most severe, then newest. */
export function compareStatusIncidents(a: OrgStatusIncident, b: OrgStatusIncident): number {
  const aActive = a.resolvedAt ? 1 : 0;
  const bActive = b.resolvedAt ? 1 : 0;
  if (aActive !== bActive) return aActive - bActive;
  const impact = IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact];
  if (impact !== 0) return impact;
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0;
}

/** "DigitalOcean nyc3 degraded — 12 of your resources there" */
export function summarizeStatusIncident(incident: OrgStatusIncident): string {
  const where =
    incident.affectedRegions.length > 0
      ? ` ${incident.affectedRegions.join(", ")}`
      : incident.providerWide
        ? ""
        : incident.services.length > 0
          ? ` ${incident.services.slice(0, 3).join(", ")}`
          : "";
  const what = incident.impact === "maintenance" ? "under maintenance" : "degraded";
  const count = incident.affectedResourceCount;
  const tail =
    count > 0
      ? ` — ${count} of your ${count === 1 ? "resource" : "resources"}${incident.affectedRegions.length > 0 ? " there" : " may be affected"}`
      : "";
  return `${incident.pluginName}${where} ${what}${tail}`;
}

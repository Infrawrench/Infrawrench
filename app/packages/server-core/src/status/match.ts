/**
 * Correlating cached provider incidents with the resources an org holds —
 * the "is it me or is it them?" half of the status feature. The cache
 * (`provider_status_incidents`) is global; everything org-specific happens
 * here, at read time.
 *
 * Matching is deliberately dumb and generic: a resource is affected when the
 * incident is provider-wide, when the incident names the resource's region
 * (compared case-insensitively against the resource's `region`/`location`/
 * `zone` field), or when the incident names the resource's type. All
 * provider knowledge lives in each plugin's `parseStatusFeed` mapper.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { OrgStatusIncident, ProviderIncidentResourceSample } from "@infrawrench/client-core";
import { compareStatusIncidents } from "@infrawrench/client-core";
import { db } from "../db/client.js";
import { accounts, providerStatusIncidents, resourceChanges, resources } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";

type IncidentRow = typeof providerStatusIncidents.$inferSelect;

/** Default window for including recently-resolved incidents in the API. */
export const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Upper bound on incidents correlated per request — safety valve. */
const MAX_INCIDENTS = 50;

const SAMPLE_LIMIT = 5;

/**
 * Pure matching rule, exported for tests. Region comparison also accepts a
 * hierarchical child: a resource in `us-central1-a` matches an incident
 * naming `us-central1`, and one in `fr-par-2` matches `fr-par` — providers
 * with zone/AZ suffixes all use a `-` separator, so the prefix check stays
 * generic.
 */
export function resourceMatchesIncident(
  incident: Pick<IncidentRow, "providerWide" | "regions" | "resourceTypeIds">,
  resourceTypeId: string,
  region: string | null,
): boolean {
  if (incident.providerWide) return true;
  if (region) {
    const lower = region.toLowerCase();
    if (
      incident.regions.some(
        (r) => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}-`),
      )
    ) {
      return true;
    }
  }
  return incident.resourceTypeIds.includes(resourceTypeId);
}

export interface IncidentMatch {
  affectedResourceCount: number;
  /** The subset of the incident's regions the org holds resources in. */
  affectedRegions: string[];
  sampleResources: ProviderIncidentResourceSample[];
}

/**
 * Match a set of cached incidents against one org's resources. Loads the
 * org's resources for the union of the incidents' plugins once, then applies
 * the pure rule per (incident, resource).
 */
export async function matchIncidentsForOrg(
  organizationId: string,
  incidents: IncidentRow[],
): Promise<Map<string, IncidentMatch>> {
  const matches = new Map<string, IncidentMatch>();
  if (incidents.length === 0) return matches;
  const pluginIds = Array.from(new Set(incidents.map((i) => i.pluginId)));

  // Only the region placement value is needed for matching — not the full
  // fields bag. Extract it in SQL so we don't ship every resource's jsonb.
  const rows = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      region: sql<string | null>`COALESCE(
        NULLIF(TRIM(${resources.fieldsJson}->>'region'), ''),
        NULLIF(TRIM(${resources.fieldsJson}->>'location'), ''),
        NULLIF(TRIM(${resources.fieldsJson}->>'zone'), '')
      )`,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.pluginId, pluginIds),
        isNull(resources.deletedAt),
      ),
    );

  // Group once so each incident only scans its plugin's resources.
  const byPlugin = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPlugin.get(row.pluginId);
    if (list) list.push(row);
    else byPlugin.set(row.pluginId, [row]);
  }

  for (const incident of incidents) {
    let count = 0;
    const regions = new Set<string>();
    const samples: ProviderIncidentResourceSample[] = [];
    const pluginRows = byPlugin.get(incident.pluginId) ?? [];
    for (const row of pluginRows) {
      const region = row.region;
      if (!resourceMatchesIncident(incident, row.resourceTypeId, region)) continue;
      count += 1;
      if (region) {
        const lower = region.toLowerCase();
        const hit = incident.regions.find(
          (r) => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}-`),
        );
        if (hit) regions.add(hit);
      }
      if (samples.length < SAMPLE_LIMIT) {
        samples.push({
          id: row.id,
          displayName: row.displayName,
          resourceTypeId: row.resourceTypeId,
          region,
        });
      }
    }
    matches.set(incident.id, {
      affectedResourceCount: count,
      affectedRegions: Array.from(regions),
      sampleResources: samples,
    });
  }
  return matches;
}

/**
 * Incidents overlapping one org: active incidents plus incidents resolved
 * within `resolvedWithinMs` (so the Changes page can correlate recent drift
 * with a just-resolved incident), each annotated with the org's affected
 * resources and the count of resource changes recorded during the incident
 * window. Sorted active-first, most severe first.
 */
export async function getOrgStatusIncidents(
  organizationId: string,
  options: { resolvedWithinMs?: number } = {},
): Promise<OrgStatusIncident[]> {
  const resolvedWithinMs = options.resolvedWithinMs ?? RESOLVED_WINDOW_MS;

  const orgPlugins = await db
    .selectDistinct({ pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const pluginIds = orgPlugins.map((r) => r.pluginId);
  if (pluginIds.length === 0) return [];

  const cutoff = new Date(Date.now() - resolvedWithinMs);
  // Active first (resolvedAt IS NULL sorts before non-null), then newest.
  // Without this a flood of recent resolutions can push live incidents off
  // the MAX_INCIDENTS cap.
  const incidentRows = await db
    .select()
    .from(providerStatusIncidents)
    .where(
      and(
        inArray(providerStatusIncidents.pluginId, pluginIds),
        or(
          isNull(providerStatusIncidents.resolvedAt),
          gte(providerStatusIncidents.resolvedAt, cutoff),
        ),
      ),
    )
    .orderBy(
      sql`${providerStatusIncidents.resolvedAt} IS NOT NULL`,
      desc(providerStatusIncidents.startedAt),
    )
    .limit(MAX_INCIDENTS);
  if (incidentRows.length === 0) return [];

  const [matches, pluginNames] = await Promise.all([
    matchIncidentsForOrg(organizationId, incidentRows),
    pluginDisplayNames(),
  ]);

  const changeCounts = await Promise.all(
    incidentRows.map((incident) => countOverlappingChanges(organizationId, incident)),
  );

  const result: OrgStatusIncident[] = incidentRows.map((incident, index) => {
    const match = matches.get(incident.id) ?? {
      affectedResourceCount: 0,
      affectedRegions: [],
      sampleResources: [],
    };
    return {
      id: incident.id,
      pluginId: incident.pluginId,
      pluginName: pluginNames.get(incident.pluginId) ?? incident.pluginId,
      title: incident.title,
      state: incident.state as OrgStatusIncident["state"],
      impact: incident.impact as OrgStatusIncident["impact"],
      url: incident.url,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
      lastUpdateAt: incident.lastUpdateAt ? incident.lastUpdateAt.toISOString() : null,
      lastUpdateText: incident.lastUpdateText,
      regions: incident.regions,
      services: incident.services,
      providerWide: incident.providerWide,
      affectedResourceCount: match.affectedResourceCount,
      affectedRegions: match.affectedRegions,
      sampleResources: match.sampleResources,
      overlappingChangeCount: changeCounts[index] ?? 0,
    };
  });

  result.sort(compareStatusIncidents);
  return result;
}

/**
 * How many change-timeline events the org recorded on the incident's plugin
 * between the incident's start and its resolution (or now). Plugin-level,
 * not per-resource: the point is "this drift happened *during* an upstream
 * incident", a correlation hint rather than a causal claim.
 */
async function countOverlappingChanges(
  organizationId: string,
  incident: Pick<IncidentRow, "pluginId" | "startedAt" | "resolvedAt">,
): Promise<number> {
  const windowEnd = incident.resolvedAt ?? new Date();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resourceChanges)
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        eq(resourceChanges.pluginId, incident.pluginId),
        gte(resourceChanges.createdAt, incident.startedAt),
        lte(resourceChanges.createdAt, windowEnd),
      ),
    );
  return rows[0]?.count ?? 0;
}

let cachedPluginNames: Map<string, string> | null = null;

async function pluginDisplayNames(): Promise<Map<string, string>> {
  if (cachedPluginNames) return cachedPluginNames;
  const loaded = await loadPlugins();
  cachedPluginNames = new Map(
    loaded.map((p) => [p.plugin.manifest.id, p.plugin.manifest.displayName]),
  );
  return cachedPluginNames;
}

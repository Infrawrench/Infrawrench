/**
 * Qdrant Cloud status (https://status.qdrant.io, a Better Stack status page,
 * verified 2026-10). Better Stack serves the whole page as JSON:API at
 * `/index.json`: `included` carries `status_page_resource` rows (one per
 * monitored component: "Cloud UI", "Cloud API (extern)", "Hybrid Cloud",
 * and one per region named `<Cloud> <region>`, e.g. "AWS us-east-1",
 * "GCP europe-west3", "Azure eastus") and `status_report` rows (incidents
 * and maintenances) with `aggregate_state`, `report_type`, `starts_at`,
 * `ends_at` and `affected_resources`.
 *
 * Region components map onto the `region` field clusters carry (Qdrant's
 * `cloudProviderRegionId`, the same bare region slug). The API and the UI are
 * provider-wide; "Hybrid Cloud" scopes to hybrid environments.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.qdrant.io/index.json",
  format: "custom-json",
  statusPageUrl: "https://status.qdrant.io",
};

interface JsonApiRow {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Array<{ id: string; type: string }> }>;
}

const REGION = /^(AWS|GCP|Azure)\s+([a-z0-9-]+)$/i;

interface Scope {
  regions: string[];
  services: string[];
  resourceTypes: string[];
  providerWide: boolean;
}

export function scopeFor(name: string): Scope {
  const n = name.trim();
  const region = REGION.exec(n);
  if (region) {
    return {
      regions: [region[2]!],
      services: ["Database Clusters"],
      resourceTypes: ["cluster", "backup", "collection"],
      providerWide: false,
    };
  }
  if (/hybrid/i.test(n)) {
    return {
      regions: [],
      services: [n],
      resourceTypes: ["hybrid-environment"],
      providerWide: false,
    };
  }
  if (/website|documentation/i.test(n)) {
    return { regions: [], services: [], resourceTypes: [], providerWide: false };
  }
  return { regions: [], services: [n], resourceTypes: [], providerWide: true };
}

function impactOf(type: string, state: string): StatusIncidentImpact {
  if (type === "maintenance" || state === "maintenance") return "maintenance";
  if (state === "downtime") return "major";
  return "minor";
}

function stateOf(state: string): StatusIncidentState {
  if (state === "resolved") return "resolved";
  return "investigating";
}

/** Parse Better Stack's `/index.json` into normalized incidents. Throws on malformed bodies. */
export function parseStatusFeed(body: string): StatusIncident[] {
  const doc = JSON.parse(body) as { included?: JsonApiRow[] };
  if (!doc || !Array.isArray(doc.included)) {
    throw new Error("Qdrant status feed: no `included` array");
  }
  const resources = new Map<string, string>();
  const updates = new Map<string, { message: string; at: string }>();
  for (const row of doc.included) {
    if (row.type === "status_page_resource") {
      resources.set(row.id, String(row.attributes?.["public_name"] ?? ""));
    } else if (row.type === "status_update") {
      updates.set(row.id, {
        message: String(row.attributes?.["message"] ?? ""),
        at: String(row.attributes?.["published_at"] ?? ""),
      });
    }
  }
  const out: StatusIncident[] = [];
  for (const row of doc.included) {
    if (row.type !== "status_report") continue;
    const a = row.attributes ?? {};
    const aggregate = String(a["aggregate_state"] ?? "");
    const reportType = String(a["report_type"] ?? "");
    const affected = (a["affected_resources"] as Array<{ status_page_resource_id?: string }>) ?? [];
    const scope: Scope = { regions: [], services: [], resourceTypes: [], providerWide: false };
    for (const r of affected) {
      const name = resources.get(String(r.status_page_resource_id ?? ""));
      if (!name) continue;
      const s = scopeFor(name);
      scope.regions.push(...s.regions);
      scope.services.push(...s.services);
      scope.resourceTypes.push(...s.resourceTypes);
      scope.providerWide ||= s.providerWide;
    }
    if (!affected.length) scope.providerWide = true;
    const ups = (row.relationships?.["status_updates"]?.data ?? [])
      .map((d) => updates.get(d.id))
      .filter((u): u is { message: string; at: string } => !!u)
      .sort((x, y) => x.at.localeCompare(y.at));
    const last = ups[ups.length - 1];
    const startedAt = String(a["starts_at"] ?? last?.at ?? new Date(0).toISOString());
    const endsAt = a["ends_at"] ? String(a["ends_at"]) : undefined;
    const state = stateOf(aggregate);
    out.push({
      externalId: row.id,
      title: String(a["title"] ?? "Qdrant Cloud incident"),
      state,
      impact: impactOf(reportType, aggregate),
      url: `${statusFeed.statusPageUrl}/${reportType === "maintenance" ? "maintenance" : "incident"}/${row.id}`,
      startedAt,
      ...(state === "resolved" && endsAt ? { resolvedAt: endsAt } : {}),
      ...(last?.at ? { lastUpdateAt: last.at } : {}),
      ...(last?.message ? { lastUpdateText: stripStatusHtml(last.message).slice(0, 2000) } : {}),
      regions: [...new Set(scope.regions)],
      services: [...new Set(scope.services)],
      ...(scope.resourceTypes.length ? { resourceTypes: [...new Set(scope.resourceTypes)] } : {}),
      ...(scope.providerWide ? { providerWide: true } : {}),
    });
  }
  return out;
}

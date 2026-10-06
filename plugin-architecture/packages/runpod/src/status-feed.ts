/**
 * Runpod public status feed (https://uptime.runpod.io, a Better Stack status
 * page; verified 2026-10 against `/index.json`).
 *
 * `index.json` is a JSON:API document: `included[]` holds the page's
 * components (`status_page_resource`), incidents (`status_report`, with an
 * `aggregate_state` and the components each affects) and their updates
 * (`status_update`). Any report not `resolved` is active.
 *
 * Most components are data centers named by their Runpod id (`EU-RO-1`,
 * `US-MO-1 ` with a stray trailing space), which is exactly what this plugin
 * writes into `fields.region`, so they map to regions. The API and console
 * components (`graphql: api.runpod.io`, `ui: runpod.io/console`, `Upstream
 * Systems`) affect everything; the Serverless and pod-proxy components map to
 * their resource types.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://uptime.runpod.io";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/index.json`,
  format: "custom-json",
  statusPageUrl: STATUS_PAGE,
};

const DATA_CENTER = /^[A-Z]{2,3}-[A-Z]{2,3}-\d+$/;

export interface ComponentMapping {
  region?: string;
  service?: string;
  resourceTypes?: string[];
  providerWide?: boolean;
}

export function mapComponent(rawName: string): ComponentMapping {
  const name = rawName.trim();
  if (DATA_CENTER.test(name)) return { region: name };
  const lower = name.toLowerCase();
  if (lower.startsWith("serverless")) {
    return { service: name, resourceTypes: ["serverless-endpoint"] };
  }
  if (lower.startsWith("pod proxy") || lower === "cpu cloud") {
    return { service: name, resourceTypes: ["pod"] };
  }
  if (
    lower.startsWith("graphql") ||
    lower.startsWith("ui:") ||
    lower.startsWith("upstream") ||
    lower.startsWith("rest")
  ) {
    return { service: name, providerWide: true };
  }
  return { service: name };
}

interface JsonApiItem {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: { status_updates?: { data?: Array<{ id?: string }> } };
}

interface Affected {
  status_page_resource_id?: string | number;
  status?: string;
}

const IMPACT_ORDER: StatusIncidentImpact[] = ["maintenance", "minor", "major", "critical"];

function impactOf(statuses: string[], reportType: string): StatusIncidentImpact {
  if (
    reportType === "maintenance" ||
    (statuses.length && statuses.every((s) => s === "maintenance"))
  ) {
    return "maintenance";
  }
  let worst: StatusIncidentImpact = "minor";
  for (const s of statuses) {
    const impact: StatusIncidentImpact =
      s === "downtime" ? "major" : s === "maintenance" ? "maintenance" : "minor";
    if (IMPACT_ORDER.indexOf(impact) > IMPACT_ORDER.indexOf(worst)) worst = impact;
  }
  return worst;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const doc = JSON.parse(body) as { included?: JsonApiItem[] };
  if (!doc || !Array.isArray(doc.included)) {
    throw new Error("Runpod status feed: not a status page document");
  }
  const components = new Map<string, string>();
  const updates = new Map<string, { message: string; publishedAt: string }>();
  for (const item of doc.included) {
    const a = item.attributes ?? {};
    if (item.type === "status_page_resource" && item.id) {
      components.set(String(item.id), String(a["public_name"] ?? ""));
    } else if (item.type === "status_update" && item.id) {
      updates.set(String(item.id), {
        message: String(a["message"] ?? ""),
        publishedAt: String(a["published_at"] ?? ""),
      });
    }
  }
  const out: StatusIncident[] = [];
  for (const item of doc.included) {
    if (item.type !== "status_report" || !item.id) continue;
    const a = item.attributes ?? {};
    const state = String(a["aggregate_state"] ?? "");
    if (state === "resolved" || state === "operational") continue;
    const affected = (
      Array.isArray(a["affected_resources"]) ? a["affected_resources"] : []
    ) as Affected[];
    const regions = new Set<string>();
    const services = new Set<string>();
    const types = new Set<string>();
    let providerWide = false;
    for (const r of affected) {
      const name = components.get(String(r.status_page_resource_id ?? ""));
      if (!name) continue;
      const m = mapComponent(name);
      if (m.region) regions.add(m.region);
      if (m.service) services.add(m.service);
      for (const t of m.resourceTypes ?? []) types.add(t);
      if (m.providerWide) providerWide = true;
    }
    const latest = (item.relationships?.status_updates?.data ?? [])
      .map((ref) => updates.get(String(ref.id ?? "")))
      .filter((u): u is { message: string; publishedAt: string } => !!u && !!u.publishedAt)
      .sort((x, y) => Date.parse(y.publishedAt) - Date.parse(x.publishedAt))[0];
    const startedAt = Date.parse(String(a["starts_at"] ?? ""));
    const text = latest?.message ? stripStatusHtml(latest.message).slice(0, 500) : "";
    const reportType = String(a["report_type"] ?? "");
    // Announced maintenance that has not begun is not an outage yet.
    if (reportType === "maintenance" && startedAt > Date.now()) continue;
    out.push({
      externalId: String(item.id),
      title: String(a["title"] ?? "Runpod incident"),
      state: "investigating",
      impact: impactOf(affected.map((r) => String(r.status ?? "")).filter(Boolean), reportType),
      url: `${STATUS_PAGE}/${reportType === "maintenance" ? "maintenance" : "incident"}/${encodeURIComponent(String(item.id))}`,
      startedAt: Number.isNaN(startedAt)
        ? new Date(0).toISOString()
        : new Date(startedAt).toISOString(),
      ...(latest ? { lastUpdateAt: new Date(Date.parse(latest.publishedAt)).toISOString() } : {}),
      ...(text ? { lastUpdateText: text } : {}),
      regions: [...regions],
      services: [...services],
      ...(types.size > 0 ? { resourceTypes: [...types] } : {}),
      // An incident naming no component gives nothing to scope by.
      providerWide: providerWide || (regions.size === 0 && services.size === 0),
    });
  }
  return out;
}

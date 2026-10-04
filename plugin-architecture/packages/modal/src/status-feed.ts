/**
 * Modal public status feed (https://status.modal.com, a Better Stack status
 * page; verified 2026-10 against `/index.json`).
 *
 * `index.json` is a JSON:API document: `included[]` carries the page's
 * components (`status_page_resource`, e.g. "Functions", "Volumes"), its
 * incidents (`status_report`, with `aggregate_state` and the components each
 * affects) and their updates (`status_update`). A report whose
 * `aggregate_state` is anything but `resolved` is an active incident.
 * Components map onto this plugin's resource types where one corresponds;
 * the rest ("Sandboxes", "Dashboard", the endpoint products) scope by service
 * name only.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.modal.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/index.json`,
  format: "custom-json",
  statusPageUrl: STATUS_PAGE,
};

const RESOURCE_TYPES: Record<string, string[]> = {
  Deployment: ["app"],
  Functions: ["function", "scheduled-function"],
  "Web Functions": ["function"],
  Servers: ["function"],
  Volumes: ["volume"],
  Dicts: ["dict"],
  Queues: ["queue"],
  Secrets: ["secret"],
};

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
  if (reportType === "maintenance" || statuses.every((s) => s === "maintenance")) {
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
    throw new Error("Modal status feed: not a status page document");
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
    const services = new Set<string>();
    const types = new Set<string>();
    for (const r of affected) {
      const name = components.get(String(r.status_page_resource_id ?? ""));
      if (!name) continue;
      services.add(name);
      for (const t of RESOURCE_TYPES[name] ?? []) types.add(t);
    }
    const latest = (item.relationships?.status_updates?.data ?? [])
      .map((ref) => updates.get(String(ref.id ?? "")))
      .filter((u): u is { message: string; publishedAt: string } => !!u && !!u.publishedAt)
      .sort((x, y) => Date.parse(y.publishedAt) - Date.parse(x.publishedAt))[0];
    const startedAt = Date.parse(String(a["starts_at"] ?? ""));
    const text = latest?.message ? stripStatusHtml(latest.message).slice(0, 500) : "";
    out.push({
      externalId: String(item.id),
      title: String(a["title"] ?? "Modal incident"),
      state: "investigating",
      impact: impactOf(
        affected.map((r) => String(r.status ?? "")).filter(Boolean),
        String(a["report_type"] ?? ""),
      ),
      url: `${STATUS_PAGE}/incident/${encodeURIComponent(String(item.id))}`,
      startedAt: Number.isNaN(startedAt)
        ? new Date(0).toISOString()
        : new Date(startedAt).toISOString(),
      ...(latest ? { lastUpdateAt: new Date(Date.parse(latest.publishedAt)).toISOString() } : {}),
      ...(text ? { lastUpdateText: text } : {}),
      regions: [],
      services: [...services],
      ...(types.size > 0 ? { resourceTypes: [...types] } : {}),
      // An incident naming no component gives nothing to scope by.
      providerWide: services.size === 0,
    });
  }
  return out;
}

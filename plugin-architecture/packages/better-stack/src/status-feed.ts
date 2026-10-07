/**
 * Better Stack public status feed (https://status.betterstack.com, itself a
 * Better Stack status page; verified 2026-10 against `/index.json`).
 *
 * `index.json` is a JSON:API document: `included[]` holds the page's
 * components (`status_page_resource`), reports (`status_report`, with an
 * `aggregate_state` and the components each affects) and their updates
 * (`status_update`). Any report not `resolved` is active. The components are
 * "Better Stack" (everything), "Uptime" and "Telemetry", which map onto this
 * plugin's resource types.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";

const STATUS_PAGE = "https://status.betterstack.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/index.json`,
  format: "custom-json",
  statusPageUrl: STATUS_PAGE,
};

const UPTIME_TYPES = [
  "monitor",
  "monitor-group",
  "heartbeat",
  "heartbeat-group",
  "status-page",
  "status-page-section",
  "status-page-resource",
  "status-report",
  "on-call-calendar",
  "incident",
  "escalation-policy",
];
const TELEMETRY_TYPES = ["source", "source-group", "dashboard", "telemetry-alert"];

export function mapComponent(rawName: string): {
  service: string;
  resourceTypes?: string[];
  providerWide?: boolean;
} {
  const name = rawName.trim();
  const lower = name.toLowerCase();
  if (lower.startsWith("uptime")) return { service: name, resourceTypes: UPTIME_TYPES };
  if (lower.startsWith("telemetry") || lower.startsWith("logs"))
    return { service: name, resourceTypes: TELEMETRY_TYPES };
  return { service: name, providerWide: true };
}

interface Item {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: { status_updates?: { data?: Array<{ id?: string }> } };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const doc = JSON.parse(body) as { included?: Item[] };
  if (!doc || !Array.isArray(doc.included))
    throw new Error("Better Stack status feed: not a status page document");
  const components = new Map<string, string>();
  const updates = new Map<string, { message: string; publishedAt: string }>();
  for (const item of doc.included) {
    const a = item.attributes ?? {};
    if (item.type === "status_page_resource" && item.id)
      components.set(String(item.id), String(a["public_name"] ?? ""));
    if (item.type === "status_update" && item.id) {
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
    const reportType = String(a["report_type"] ?? "");
    const startedAt = Date.parse(String(a["starts_at"] ?? ""));
    if (reportType === "maintenance" && startedAt > Date.now()) continue;
    const affected = (
      Array.isArray(a["affected_resources"]) ? a["affected_resources"] : []
    ) as Array<{
      status_page_resource_id?: string | number;
      status?: string;
    }>;
    const services = new Set<string>();
    const types = new Set<string>();
    let providerWide = false;
    for (const r of affected) {
      const name = components.get(String(r.status_page_resource_id ?? ""));
      if (!name) continue;
      const m = mapComponent(name);
      services.add(m.service);
      for (const t of m.resourceTypes ?? []) types.add(t);
      if (m.providerWide) providerWide = true;
    }
    const statuses = affected.map((r) => String(r.status ?? ""));
    const impact: StatusIncidentImpact =
      reportType === "maintenance" ||
      (statuses.length > 0 && statuses.every((s) => s === "maintenance"))
        ? "maintenance"
        : statuses.includes("downtime")
          ? "major"
          : "minor";
    const latest = (item.relationships?.status_updates?.data ?? [])
      .map((ref) => updates.get(String(ref.id ?? "")))
      .filter((u): u is { message: string; publishedAt: string } => !!u && !!u.publishedAt)
      .sort((x, y) => Date.parse(y.publishedAt) - Date.parse(x.publishedAt))[0];
    const text = latest?.message ? stripStatusHtml(latest.message).slice(0, 500) : "";
    out.push({
      externalId: String(item.id),
      title: String(a["title"] ?? "Better Stack incident"),
      state: "investigating",
      impact,
      url: `${STATUS_PAGE}/${reportType === "maintenance" ? "maintenance" : "incident"}/${encodeURIComponent(String(item.id))}`,
      startedAt: Number.isNaN(startedAt)
        ? new Date(0).toISOString()
        : new Date(startedAt).toISOString(),
      ...(latest ? { lastUpdateAt: new Date(Date.parse(latest.publishedAt)).toISOString() } : {}),
      ...(text ? { lastUpdateText: text } : {}),
      regions: [],
      services: [...services],
      ...(types.size > 0 ? { resourceTypes: [...types] } : {}),
      providerWide: providerWide || services.size === 0,
    });
  }
  return out;
}

/**
 * Vultr's status page (https://status.vultr.com) is not Statuspage; its data
 * is `https://status.vultr.com/status.json` (checked 2026-10-06):
 *
 *   { "service_alerts": [ { id, region?, subject, status, start_date,
 *                           updated_at, entries: [{ updated_at, message }] } ],
 *     "regions": { "atl": { location, country, alerts: [ same shape ] } } }
 *
 * Region keys are the same ids the API uses (`ewr`, `atl`, `sgp`), which is
 * what the plugin writes into `fields.region`. Service alerts carry an
 * optional `region`; without one they are provider-wide. `status` is
 * `ongoing` while active; anything else (`resolved`, `completed`) is closed.
 */

import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentImpact,
  StatusIncidentState,
} from "@infrawrench/plugin-base";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.vultr.com/status.json",
  format: "custom-json",
  statusPageUrl: "https://status.vultr.com",
};

interface VultrAlert {
  id?: string;
  region?: string;
  subject?: string;
  status?: string;
  start_date?: string;
  updated_at?: string;
  entries?: Array<{ updated_at?: string; message?: string }>;
}

interface VultrStatusBody {
  service_alerts?: VultrAlert[];
  regions?: Record<string, { location?: string; alerts?: VultrAlert[] }>;
}

export function impactOf(subject: string): StatusIncidentImpact {
  const s = subject.toLowerCase();
  if (s.includes("maintenance")) return "maintenance";
  if (s.includes("partial") || s.includes("degraded") || s.includes("latency")) return "minor";
  if (s.includes("outage") || s.includes("down")) return "major";
  return "minor";
}

function stateOf(status: string | undefined): StatusIncidentState {
  const s = (status ?? "").toLowerCase();
  if (s === "ongoing" || s === "" || s === "scheduled" || s === "in_progress")
    return "investigating";
  if (s === "monitoring") return "monitoring";
  if (s === "identified") return "identified";
  return "resolved";
}

const iso = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as VultrStatusBody;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Vultr status feed: not a JSON object");
  const byId = new Map<string, StatusIncident>();
  const add = (alert: VultrAlert, region: string | undefined) => {
    const id = alert.id ?? `${region ?? "global"}:${alert.subject ?? ""}:${alert.start_date ?? ""}`;
    const entries = [...(alert.entries ?? [])].sort((a, b) =>
      (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
    );
    const last = entries[entries.length - 1];
    const state = stateOf(alert.status);
    const existing = byId.get(id);
    if (existing) {
      if (region && !existing.regions.includes(region)) existing.regions.push(region);
      if (region) delete existing.providerWide;
      return;
    }
    const title = alert.subject?.trim() || "Vultr service alert";
    const lastUpdateAt = iso(last?.updated_at) ?? iso(alert.updated_at);
    const incident: StatusIncident = {
      externalId: id,
      title,
      state,
      impact: impactOf(title),
      url: "https://status.vultr.com",
      startedAt: iso(alert.start_date) ?? new Date(0).toISOString(),
      ...(state === "resolved" && lastUpdateAt ? { resolvedAt: lastUpdateAt } : {}),
      ...(lastUpdateAt ? { lastUpdateAt } : {}),
      ...(last?.message ? { lastUpdateText: last.message.replace(/\s+/g, " ").trim() } : {}),
      regions: region ? [region] : [],
      services: [],
      ...(region ? {} : { providerWide: true }),
    };
    byId.set(id, incident);
  };
  for (const [region, info] of Object.entries(parsed.regions ?? {})) {
    for (const alert of info.alerts ?? []) add(alert, region);
  }
  for (const alert of parsed.service_alerts ?? []) add(alert, alert.region || undefined);
  return [...byId.values()];
}

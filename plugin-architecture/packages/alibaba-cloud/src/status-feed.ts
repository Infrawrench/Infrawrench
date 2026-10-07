/**
 * Alibaba Cloud status feed: the international status page
 * (https://status.alibabacloud.com) is a single-page app over a small JSON
 * API. `GET /api/status/listEventInProgress` answers anonymously with
 * `{ data: [...], success, code }`, each event shaped like the history
 * endpoint's (`/api/status/listHistoryEvent`, verified 2026-10):
 * `{ id, title, eventType: "ALARM", startTime, endTime, lastUpdateTime,
 * products, regions, eventUpdates }`, times in epoch milliseconds. Titles
 * read "[Incident (Recovered)] Network Access Abnormality ... in Zone B,
 * Indonesia (Jakarta) Region", so the region comes from the title when the
 * event carries no `regions`.
 */
import type {
  StatusFeedDeclaration,
  StatusIncident,
  StatusIncidentState,
} from "@infrawrench/plugin-base";
import { stripStatusHtml } from "@infrawrench/plugin-base";
import { ALI_REGIONS, regionIdForLabel } from "./regions.js";

export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.alibabacloud.com/api/status/listEventInProgress",
  format: "custom-json",
  statusPageUrl: "https://status.alibabacloud.com",
};

interface StatusEvent {
  id?: number | string;
  title?: string;
  eventType?: string;
  startTime?: number | null;
  endTime?: number | null;
  lastUpdateTime?: number | null;
  products?: unknown;
  regions?: unknown;
  eventUpdates?: Array<{ content?: string; publishTime?: number }> | null;
}

function names(value: unknown, keys: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") {
      for (const k of keys) {
        const s = (v as Record<string, unknown>)[k];
        if (typeof s === "string" && s) {
          out.push(s);
          break;
        }
      }
    }
  }
  return out;
}

function stateOf(e: StatusEvent): StatusIncidentState {
  const title = e.title ?? "";
  if (/recovered|resolved|completed/i.test(title)) return "resolved";
  if (e.endTime && e.endTime <= Date.now()) return "resolved";
  if (/monitor/i.test(title)) return "monitoring";
  if (/identified|repairing|recovering/i.test(title)) return "identified";
  return "investigating";
}

function iso(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const parsed = JSON.parse(body) as { data?: StatusEvent[] | null; success?: boolean };
  if (parsed.success === false) throw new Error("Alibaba Cloud status API reported a failure");
  const out: StatusIncident[] = [];
  for (const e of parsed.data ?? []) {
    if (!e.title || e.id === undefined) continue;
    const state = stateOf(e);
    if (state === "resolved") continue;
    const title = e.title.trim();
    const regionIds = new Set<string>();
    for (const r of names(e.regions, ["regionId", "regionName", "name"])) {
      const id = ALI_REGIONS.some((x) => x.id === r) ? r : regionIdForLabel(r);
      if (id) regionIds.add(id);
    }
    if (regionIds.size === 0) {
      const fromTitle = regionIdForLabel(title);
      if (fromTitle) regionIds.add(fromTitle);
    }
    const services = names(e.products, ["productName", "name", "productCode"]);
    const latest = [...(e.eventUpdates ?? [])].sort(
      (a, b) => (b.publishTime ?? 0) - (a.publishTime ?? 0),
    )[0];
    const startedAt = iso(e.startTime) ?? new Date().toISOString();
    out.push({
      externalId: String(e.id),
      title,
      state,
      impact: /maintenance|upgrade/i.test(`${e.eventType ?? ""} ${title}`)
        ? "maintenance"
        : "major",
      url: statusFeed.statusPageUrl!,
      startedAt,
      lastUpdateAt: iso(latest?.publishTime) ?? iso(e.lastUpdateTime) ?? startedAt,
      ...(latest?.content ? { lastUpdateText: stripStatusHtml(latest.content).slice(0, 500) } : {}),
      regions: [...regionIds],
      services,
      ...(regionIds.size === 0 ? { providerWide: true } : {}),
    });
  }
  return out;
}

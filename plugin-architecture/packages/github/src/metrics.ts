/**
 * Metric series for the billing account's Metrics tab.
 *
 * - Actions minutes by runner OS, Codespaces compute hours, premium requests,
 *   AI credits and daily net spend all come from the usage report's dated
 *   line items (one call per month in the window), which is the same data
 *   the cost collector reads.
 * - Copilot daily and weekly active users come from the Copilot usage metrics
 *   reports (`GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest`
 *   or `/enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest`).
 *   Those return short-lived signed `download_links` to NDJSON files; each
 *   record wraps a `day_totals` array of daily aggregates carrying `day`,
 *   `daily_active_users` and `weekly_active_users` (GitHub's "Copilot usage
 *   metrics" reference, verified 2026-10). The signed links are fetched
 *   without the token: they authorize themselves.
 */

import type { HttpHostServices, MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { GitHubContext } from "./api.js";
import { ghFetch, ownerBase } from "./api.js";
import { normalizeId, runnerOs } from "./products.js";
import type { TaggedUsageItem } from "./usage.js";
import { fetchMonthItems, isoDay, monthsBetween } from "./usage.js";

export const METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(
  range: TimeRange | undefined,
  windowMs = METRICS_WINDOW_MS,
): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const dayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

function seriesFrom(label: string, unit: string, byDay: Map<string, number>): MetricSeries | null {
  if (byDay.size === 0) return null;
  const points: MetricSeriesPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ timestamp: dayMs(day), value: Math.round(value * 1000) / 1000 }));
  return { label, unit, points };
}

function add(map: Map<string, Map<string, number>>, series: string, day: string, value: number) {
  const inner = map.get(series) ?? new Map<string, number>();
  inner.set(day, (inner.get(day) ?? 0) + value);
  map.set(series, inner);
}

/**
 * Daily usage series from line items, already filtered to the window. Pure,
 * so it can be tested without the network.
 */
export function usageSeries(items: TaggedUsageItem[], range: TimeRange): MetricSeries[] {
  const from = dayIso(range.startMs);
  const to = dayIso(range.endMs);
  const minutes = new Map<string, Map<string, number>>();
  const other = new Map<string, Map<string, number>>();
  for (const item of items) {
    const day = isoDay(item.date);
    if (!day || day < from || day > to) continue;
    const sku = normalizeId(item.sku);
    const unit = normalizeId(item.unitType);
    const qty = item.quantity ?? 0;
    const os = runnerOs(sku);
    if (os && unit === "minutes") add(minutes, os, day, qty);
    if (sku.startsWith("codespaces_compute")) add(other, "Codespaces compute", day, qty);
    if (unit === "requests" || sku.includes("premium_request")) {
      add(other, "Premium requests", day, qty);
    } else if (unit.includes("credit") || sku.includes("ai_credit")) {
      add(other, "AI credits", day, qty);
    }
    add(other, "Net spend", day, item.netAmount ?? 0);
  }
  const out: MetricSeries[] = [];
  for (const os of ["Linux", "Windows", "macOS"]) {
    const s = minutes.get(os);
    const built = s ? seriesFrom(`Actions minutes (${os})`, "min", s) : null;
    if (built) out.push(built);
  }
  const units: Record<string, string> = {
    "Codespaces compute": "hours",
    "Premium requests": "requests",
    "AI credits": "credits",
    "Net spend": "USD",
  };
  for (const label of ["Codespaces compute", "Premium requests", "AI credits", "Net spend"]) {
    const s = other.get(label);
    const built = s ? seriesFrom(label, units[label]!, s) : null;
    if (built) out.push(built);
  }
  return out;
}

interface CopilotDayTotals {
  day?: string;
  daily_active_users?: number;
  weekly_active_users?: number;
}

/** Parse NDJSON report bodies into per-day active-user counts. */
export function parseCopilotReport(bodies: string[]): CopilotDayTotals[] {
  const days = new Map<string, CopilotDayTotals>();
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: { day?: string; day_totals?: CopilotDayTotals[] } & CopilotDayTotals;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const entries = Array.isArray(record.day_totals) ? record.day_totals : [record];
      for (const e of entries) {
        if (e.day) days.set(e.day.slice(0, 10), e);
      }
    }
  }
  return [...days.values()];
}

async function download(url: string, http: HttpHostServices | undefined): Promise<string> {
  if (http) {
    const res = await http.request({ url, method: "GET", headers: {} });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`Copilot report download ${res.status}`);
    return res.body;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Copilot report download ${res.status}`);
  return res.text();
}

export async function copilotActiveUserSeries(
  ctx: GitHubContext,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const report =
    ctx.owner.kind === "org" ? "organization-28-day/latest" : "enterprise-28-day/latest";
  const res = await ghFetch<{ download_links?: string[] }>(
    ctx,
    `${ownerBase(ctx.owner)}/copilot/metrics/reports/${report}`,
  );
  const bodies: string[] = [];
  for (const link of res.download_links ?? []) {
    bodies.push(await download(link, ctx.http));
  }
  const from = dayIso(range.startMs);
  const to = dayIso(range.endMs);
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();
  for (const d of parseCopilotReport(bodies)) {
    const day = d.day!.slice(0, 10);
    if (day < from || day > to) continue;
    if (typeof d.daily_active_users === "number") daily.set(day, d.daily_active_users);
    if (typeof d.weekly_active_users === "number") weekly.set(day, d.weekly_active_users);
  }
  return [
    seriesFrom("Copilot daily active users", "users", daily),
    seriesFrom("Copilot weekly active users", "users", weekly),
  ].filter((s): s is MetricSeries => s !== null);
}

/** Every series for the billing account. A source that fails is left out, not fatal. */
export async function billingAccountSeries(
  ctx: GitHubContext,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const usage = (async () => {
    const items: TaggedUsageItem[] = [];
    for (const ym of monthsBetween(dayIso(range.startMs), dayIso(range.endMs))) {
      items.push(...(await fetchMonthItems(ctx, ym)));
    }
    return usageSeries(items, range);
  })().catch(() => [] as MetricSeries[]);
  const copilot = copilotActiveUserSeries(ctx, range).catch(() => [] as MetricSeries[]);
  const [u, c] = await Promise.all([usage, copilot]);
  return [...u, ...c];
}

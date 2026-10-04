/**
 * Metric series for the Metrics tab.
 *
 * - Team: daily units and GB by pillar, and units by TCO priority, from the
 *   same daily usage the cost collector reads (`usage.ts`), plus the daily
 *   quota as a flat line where the team's quota is readable.
 * - Alerts: `GET /alerts/alerts/v3/all/events` for the alert's version id,
 *   counted per hour (per day over windows longer than three days).
 * - TCO policies: `POST /dataplans/policies/v1/all/forecast-usage` with the
 *   policy's own rules over the last week, which returns the bytes those
 *   rules matched per bucket. That is the volume the policy's priority is
 *   being applied to, which is what decides whether changing it is worth it.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { CoralogixContext } from "./api.js";
import { cxFetch } from "./api.js";
import type { CxPolicy } from "./mappers.js";
import type { Pillar, Priority, UsageCell } from "./usage.js";
import { PILLAR_LABELS, PRIORITY_LABELS, fetchUsageCells } from "./usage.js";

export const TEAM_METRICS_WINDOW_MS = 30 * 86_400_000;
export const ALERT_METRICS_WINDOW_MS = 7 * 86_400_000;
export const POLICY_METRICS_WINDOW_MS = 7 * 86_400_000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

function seriesBy<K extends string>(
  cells: UsageCell[],
  keyOf: (c: UsageCell) => K | undefined,
  labelOf: (k: K) => string,
  valueOf: (c: UsageCell) => number | undefined,
  unit: string,
): MetricSeries[] {
  const byKey = new Map<K, Map<string, number>>();
  for (const c of cells) {
    const k = keyOf(c);
    const v = valueOf(c);
    if (k === undefined || v === undefined) continue;
    const days = byKey.get(k) ?? new Map<string, number>();
    days.set(c.date, (days.get(c.date) ?? 0) + v);
    byKey.set(k, days);
  }
  const allDays = [...new Set(cells.map((c) => c.date))].sort();
  return [...byKey.entries()]
    .map(([k, days]) => ({
      label: labelOf(k),
      unit,
      points: allDays.map((d) => ({ timestamp: dayMs(d), value: days.get(d) ?? 0 })),
    }))
    .filter((s) => s.points.some((p) => p.value > 0));
}

/** Daily usage charts for the team. */
export async function teamSeries(
  ctx: CoralogixContext,
  range: TimeRange,
  dailyQuota?: number,
): Promise<MetricSeries[]> {
  const cells = await fetchUsageCells(ctx, {
    fromDate: day(range.startMs),
    toDate: day(range.endMs),
  });
  const units = seriesBy<Pillar>(
    cells,
    (c) => c.pillar,
    (k) => `Units: ${PILLAR_LABELS[k]}`,
    (c) => c.units,
    "units",
  );
  const priorities = seriesBy<Priority>(
    cells,
    (c) => c.priority,
    (k) => `Units: ${PRIORITY_LABELS[k]}`,
    (c) => c.units,
    "units",
  );
  const gb = seriesBy<Pillar>(
    cells,
    (c) => c.pillar,
    (k) => `GB: ${PILLAR_LABELS[k]}`,
    (c) => c.gb,
    "GB",
  );
  const out = [...units, ...priorities, ...gb];
  if (dailyQuota !== undefined && dailyQuota > 0 && cells.length > 0) {
    const days = [...new Set(cells.map((c) => c.date))].sort();
    out.push({
      label: "Daily quota",
      unit: "units",
      points: days.map((d) => ({ timestamp: dayMs(d), value: dailyQuota })),
    });
  }
  return out;
}

interface AlertEventsResponse {
  events?: Array<{ cxEventTimestamp?: string; cxEventType?: string }>;
  pagination?: { nextPageToken?: string };
}

const MAX_EVENT_PAGES = 10;

/** Trigger events for one alert version, bucketed by hour or day. */
export async function alertSeries(
  ctx: CoralogixContext,
  alertVersionId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  if (!alertVersionId) return [];
  const bucketMs = range.endMs - range.startMs > 3 * 86_400_000 ? 86_400_000 : 3_600_000;
  const counts = new Map<number, number>();
  let token: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = await cxFetch<AlertEventsResponse>(ctx, "/alerts/alerts/v3/all/events", {
      query: {
        alert_ids: [alertVersionId],
        "timestamp_range.from": new Date(range.startMs).toISOString(),
        "timestamp_range.to": new Date(range.endMs).toISOString(),
        "pagination.pageSize": 500,
        ...(token ? { "pagination.pageToken": token } : {}),
      },
    });
    for (const e of res?.events ?? []) {
      const ms = Date.parse(e.cxEventTimestamp ?? "");
      if (!Number.isFinite(ms)) continue;
      const b = Math.floor(ms / bucketMs) * bucketMs;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    token = res?.pagination?.nextPageToken || undefined;
    if (!token) break;
  }
  const points: MetricSeriesPoint[] = [];
  for (let t = Math.floor(range.startMs / bucketMs) * bucketMs; t <= range.endMs; t += bucketMs) {
    points.push({ timestamp: t, value: counts.get(t) ?? 0 });
  }
  return [{ label: "Trigger events", unit: "events", points }];
}

interface ForecastResponse {
  estimatedBytes?: string;
  usageBuckets?: Array<{ bucketStartMs?: string; bytes?: string }>;
}

/** The request body that forecasts a policy's own rules. */
export function forecastBody(p: CxPolicy, bucketMs: number): Record<string, unknown> {
  return {
    ...(p.applicationRule ? { applicationRule: p.applicationRule } : {}),
    ...(p.subsystemRule ? { subsystemRule: p.subsystemRule } : {}),
    ...(p.logRules ? { logRules: p.logRules } : {}),
    ...(p.spanRules ? { spanRules: p.spanRules } : {}),
    ...(p.rumRules ? { rumRules: p.rumRules } : {}),
    week: {},
    timeBucketMs: String(bucketMs),
  };
}

const POLICY_BUCKET_MS = 6 * 3_600_000;

/** GB a policy's rules matched over the last week, in six-hour buckets. */
export async function policySeries(ctx: CoralogixContext, p: CxPolicy): Promise<MetricSeries[]> {
  const res = await cxFetch<ForecastResponse>(ctx, "/dataplans/policies/v1/all/forecast-usage", {
    method: "POST",
    body: forecastBody(p, POLICY_BUCKET_MS),
  });
  const points: MetricSeriesPoint[] = [];
  for (const b of res?.usageBuckets ?? []) {
    const ts = Number(b.bucketStartMs);
    const bytes = Number(b.bytes);
    if (Number.isFinite(ts) && Number.isFinite(bytes)) {
      points.push({ timestamp: ts, value: bytes / 1e9 });
    }
  }
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points.length > 0 ? [{ label: "Matched volume", unit: "GB", points }] : [];
}

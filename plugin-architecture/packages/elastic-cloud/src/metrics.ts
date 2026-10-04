/**
 * Cost charts from the Billing API (v2). Elastic Cloud publishes no
 * time-series of cluster health through the Cloud API, so the Metrics tab is
 * the daily cost of the organization, a deployment or a project, broken down
 * the way Elastic's own Usage page breaks it down:
 *
 * - `GET /api/v2/billing/organizations/{org}/charts`: one value per
 *   instance per bucket.
 * - `GET /api/v2/billing/organizations/{org}/instances/{id}/charts`: one
 *   value per line-item category per bucket.
 *
 * Point-in-time cluster readings (JVM memory pressure, disk use per instance)
 * come from the deployment itself and are on the detail page and dashboard
 * card instead.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { EcContext } from "./api.js";
import { billingApi } from "./api.js";
import type { EcChartItems } from "./types.js";

const DAY_MS = 86_400_000;
export const COST_METRICS_WINDOW_MS = 30 * DAY_MS;
/** Series beyond this are folded into "Other" so the chart stays readable. */
const MAX_SERIES = 8;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** Chart timestamps are epoch values; accept seconds as well as milliseconds. */
function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Turn chart buckets into one series per value name, largest first, the tail folded. */
export function chartToSeries(chart: EcChartItems): MetricSeries[] {
  const byName = new Map<string, Map<number, number>>();
  const totals = new Map<string, number>();
  const stamps = new Set<number>();
  for (const bucket of chart.data ?? []) {
    if (typeof bucket.timestamp !== "number") continue;
    const ts = toMs(bucket.timestamp);
    stamps.add(ts);
    for (const v of bucket.values ?? []) {
      const name = v.name || v.id || "Other";
      const value = Number(v.value ?? 0);
      if (!Number.isFinite(value)) continue;
      const points = byName.get(name) ?? new Map<number, number>();
      points.set(ts, (points.get(ts) ?? 0) + value);
      byName.set(name, points);
      totals.set(name, (totals.get(name) ?? 0) + value);
    }
  }
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const keep = ordered.slice(0, MAX_SERIES - (ordered.length > MAX_SERIES ? 1 : 0));
  const folded = ordered.slice(keep.length);
  const sortedStamps = [...stamps].sort((a, b) => a - b);
  const series: MetricSeries[] = keep.map((name) => ({
    label: name,
    unit: "USD",
    points: sortedStamps.map((timestamp) => ({
      timestamp,
      value: round(byName.get(name)?.get(timestamp) ?? 0),
    })),
  }));
  if (folded.length > 0) {
    series.push({
      label: "Other",
      unit: "USD",
      points: sortedStamps.map((timestamp) => ({
        timestamp,
        value: round(folded.reduce((s, n) => s + (byName.get(n)?.get(timestamp) ?? 0), 0)),
      })),
    });
  }
  return series;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

function window(range: TimeRange) {
  return {
    from: new Date(range.startMs).toISOString(),
    to: new Date(range.endMs).toISOString(),
    bucketing_strategy: range.endMs - range.startMs > 120 * DAY_MS ? "monthly" : "daily",
  };
}

export async function organizationCostSeries(
  ctx: EcContext,
  orgId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const chart = await billingApi<EcChartItems>(
    ctx,
    `/api/v2/billing/organizations/${encodeURIComponent(orgId)}/charts`,
    { query: window(range) },
  );
  return chartToSeries(chart ?? {});
}

export async function instanceCostSeries(
  ctx: EcContext,
  orgId: string,
  instanceId: string,
  instanceType: "deployments" | "projects",
  range: TimeRange,
): Promise<MetricSeries[]> {
  const chart = await billingApi<EcChartItems>(
    ctx,
    `/api/v2/billing/organizations/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(instanceId)}/charts`,
    { query: { ...window(range), instance_type: instanceType } },
  );
  return chartToSeries(chart ?? {});
}

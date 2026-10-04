/**
 * Metric series for the Metrics tab. ACUs come from the daily consumption
 * endpoints (already one point per billing day). Sessions, pull requests and
 * searches come from `metrics/usage`, `metrics/sessions` and `metrics/prs`,
 * which aggregate over whatever window they are given, so the range is cut
 * into buckets (one per billing day up to a month, at most 31 otherwise) and
 * each bucket is one request. Daily active users come from `metrics/dau`,
 * which answers per day natively.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { ConsumptionDay, DevinContext, UsageMetrics } from "./api.js";
import { billingDay, devinFetch, fetchConsumption, mapLimit, orgPath } from "./api.js";
import { splitDay } from "./cost-data.js";
import { PRODUCT_KEYS, PRODUCT_LABELS, roundMoney } from "./pricing.js";

const DAY_MS = 86_400_000;
export const DEFAULT_METRICS_WINDOW_MS = 30 * DAY_MS;
const MAX_BUCKETS = 31;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range?: TimeRange): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - DEFAULT_METRICS_WINDOW_MS, endMs };
}

/** `[after, before)` windows in Unix seconds covering the range. */
export function buckets(range: TimeRange): Array<{ after: number; before: number }> {
  const start = Math.floor(range.startMs / 1000);
  const end = Math.ceil(range.endMs / 1000);
  if (end <= start) return [];
  const span = end - start;
  const size = Math.max(86_400, Math.ceil(span / MAX_BUCKETS));
  const out: Array<{ after: number; before: number }> = [];
  for (let t = start; t < end; t += size) out.push({ after: t, before: Math.min(end, t + size) });
  return out;
}

const dayMs = (seconds: number) => Date.parse(`${billingDay(seconds)}T00:00:00Z`);

function rangeDays(range: TimeRange): { from: string; to: string } {
  return { from: billingDay(range.startMs / 1000), to: billingDay(range.endMs / 1000) };
}

/** ACUs (total and per product) and estimated cost, one point per billing day. */
export function consumptionSeries(days: ConsumptionDay[], acuPrice: number): MetricSeries[] {
  const sorted = [...days].sort((a, b) => a.date - b.date);
  const total: MetricSeriesPoint[] = [];
  const cost: MetricSeriesPoint[] = [];
  const perProduct = new Map<string, MetricSeriesPoint[]>();
  for (const d of sorted) {
    const timestamp = dayMs(d.date);
    total.push({ timestamp, value: roundMoney(d.acus) });
    cost.push({ timestamp, value: Math.round(d.acus * acuPrice * 100) / 100 });
    const split = splitDay(d);
    for (const k of PRODUCT_KEYS) {
      const label = `ACUs: ${PRODUCT_LABELS[k]}`;
      const points = perProduct.get(label) ?? [];
      points.push({ timestamp, value: roundMoney(split[k]) });
      perProduct.set(label, points);
    }
  }
  if (total.length === 0) return [];
  const out: MetricSeries[] = [
    { label: "ACUs", unit: "ACU", points: total },
    { label: "Estimated cost", unit: "USD", points: cost },
  ];
  // Only products the window actually used; a flat zero line per unused product is noise.
  const used = [...perProduct.entries()].filter(([, pts]) => pts.some((p) => p.value > 0));
  if (used.length > 1) {
    for (const [label, points] of used) out.push({ label, unit: "ACU", points });
  }
  return out;
}

async function soft<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

export async function orgSeries(
  ctx: DevinContext,
  orgId: string,
  acuPrice: number,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const { from, to } = rangeDays(range);
  const windows = buckets(range);
  const [days, usage, dau] = await Promise.all([
    soft(() => fetchConsumption(ctx, orgPath(orgId, "/consumption/daily"), from, to)),
    soft(() =>
      mapLimit(windows, 4, async (w) => ({
        w,
        m: await devinFetch<UsageMetrics>(ctx, orgPath(orgId, "/metrics/usage"), {
          query: { time_after: w.after, time_before: w.before },
        }),
      })),
    ),
    soft(() =>
      devinFetch<Array<{ start_time: number; end_time: number; active_users: number }>>(
        ctx,
        orgPath(orgId, "/metrics/dau"),
        {
          query: {
            time_after: Math.floor(range.startMs / 1000),
            time_before: Math.ceil(range.endMs / 1000),
          },
        },
      ),
    ),
  ]);
  const out: MetricSeries[] = days ? consumptionSeries(days, acuPrice) : [];
  if (usage) {
    const series = (label: string, pick: (m: UsageMetrics) => number | undefined) => ({
      label,
      points: usage.map(({ w, m }) => ({ timestamp: w.after * 1000, value: pick(m) ?? 0 })),
    });
    out.push(
      series("Sessions", (m) => m.sessions_count),
      series("PRs created", (m) => m.prs_created_count),
      series("PRs merged", (m) => m.prs_merged_count),
      series("Searches", (m) => m.searches_count),
    );
  }
  if (dau && dau.length > 0) {
    out.push({
      label: "Daily active users",
      points: dau.map((d) => ({ timestamp: d.start_time * 1000, value: d.active_users })),
    });
  }
  return out;
}

export async function consumptionAt(
  ctx: DevinContext,
  path: string,
  acuPrice: number,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const { from, to } = rangeDays(range);
  const days = await fetchConsumption(ctx, path, from, to);
  return consumptionSeries(days, acuPrice);
}

/** Sessions that ran a playbook, and their merged pull requests, per bucket. */
export async function playbookSeries(
  ctx: DevinContext,
  orgId: string,
  playbookId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const windows = buckets(range);
  const rows = await mapLimit(windows, 4, async (w) => {
    const query = { time_after: w.after, time_before: w.before, playbook_id: playbookId };
    const [sessions, prs] = await Promise.all([
      soft(() =>
        devinFetch<{ sessions_created_count?: number }>(ctx, orgPath(orgId, "/metrics/sessions"), {
          query,
        }),
      ),
      soft(() =>
        devinFetch<{ prs_merged_count?: number }>(ctx, orgPath(orgId, "/metrics/prs"), { query }),
      ),
    ]);
    return { w, sessions, prs };
  });
  if (rows.every((r) => !r.sessions && !r.prs)) return [];
  return [
    {
      label: "Sessions",
      points: rows.map((r) => ({
        timestamp: r.w.after * 1000,
        value: r.sessions?.sessions_created_count ?? 0,
      })),
    },
    {
      label: "PRs merged",
      points: rows.map((r) => ({
        timestamp: r.w.after * 1000,
        value: r.prs?.prs_merged_count ?? 0,
      })),
    },
  ];
}

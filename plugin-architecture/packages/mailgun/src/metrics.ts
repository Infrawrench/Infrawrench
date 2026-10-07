/**
 * Daily metrics from Mailgun's Metrics API: `POST /v1/analytics/metrics` with
 * `resolution: "day"`, `dimensions: ["time"]`, dates in RFC 2822 and an
 * optional `domain` filter. Each item carries its day as
 * `dimensions[{ dimension: "time", value }]`. Analytics data lives in the
 * region it was sent from, so an account-wide series sums every region.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { MailgunContext, MailgunRegion } from "./api.js";
import { mailgunFetch } from "./api.js";

export const METRICS_WINDOW_MS = 30 * 24 * 3600_000;

export function rangeOrDefault(timeRange: { startMs: number; endMs: number } | undefined): {
  startMs: number;
  endMs: number;
} {
  if (timeRange) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - METRICS_WINDOW_MS, endMs };
}

/** RFC 2822 date the Metrics API accepts, e.g. "Tue, 07 Oct 2026 00:00:00 +0000". */
export function rfc2822(ms: number): string {
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

const SERIES: Array<{ label: string; metric: string; unit: string }> = [
  { label: "Accepted", metric: "accepted_outgoing_count", unit: "emails" },
  { label: "Delivered", metric: "delivered_count", unit: "emails" },
  { label: "Temporary failures", metric: "temporary_failed_count", unit: "emails" },
  { label: "Permanent failures", metric: "permanent_failed_count", unit: "emails" },
  { label: "Complaints", metric: "complained_count", unit: "emails" },
  { label: "Unsubscribes", metric: "unsubscribed_count", unit: "emails" },
  { label: "Unique opens", metric: "unique_opened_count", unit: "opens" },
  { label: "Unique clicks", metric: "unique_clicked_count", unit: "clicks" },
];

export const METRIC_NAMES = SERIES.map((s) => s.metric);

export interface MgMetricItem {
  dimensions?: Array<{ dimension?: string; value?: string }>;
  metrics?: Record<string, number | string | null>;
}

export async function queryMetrics(
  ctx: MailgunContext,
  region: MailgunRegion,
  range: { startMs: number; endMs: number },
  domain?: string,
): Promise<MgMetricItem[]> {
  const res = await mailgunFetch<{ items?: MgMetricItem[] }>(ctx, region, "/v1/analytics/metrics", {
    json: {
      start: rfc2822(range.startMs),
      end: rfc2822(range.endMs),
      resolution: "day",
      dimensions: ["time"],
      metrics: METRIC_NAMES,
      ...(domain
        ? {
            filter: {
              AND: [
                {
                  attribute: "domain",
                  comparator: "=",
                  values: [{ label: domain, value: domain }],
                },
              ],
            },
          }
        : {}),
      include_subaccounts: false,
    },
  });
  return res?.items ?? [];
}

/** Sum items from one or more regions per day and turn them into series. */
export function seriesFromItems(items: MgMetricItem[]): MetricSeries[] {
  const byDay = new Map<number, Record<string, number>>();
  for (const item of items) {
    const when = item.dimensions?.find((d) => d.dimension === "time")?.value;
    const ts = when ? Date.parse(when) : NaN;
    if (!Number.isFinite(ts)) continue;
    const day = Date.UTC(
      new Date(ts).getUTCFullYear(),
      new Date(ts).getUTCMonth(),
      new Date(ts).getUTCDate(),
    );
    const row = byDay.get(day) ?? {};
    for (const [k, v] of Object.entries(item.metrics ?? {})) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) row[k] = (row[k] ?? 0) + n;
    }
    byDay.set(day, row);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length === 0) return [];
  return SERIES.map((s) => ({
    label: s.label,
    unit: s.unit,
    points: days.map((d) => ({ timestamp: d, value: byDay.get(d)?.[s.metric] ?? 0 })),
  }));
}

/** Totals over every item, for the detail pages. */
export function totals(items: MgMetricItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    for (const [k, v] of Object.entries(item.metrics ?? {})) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}

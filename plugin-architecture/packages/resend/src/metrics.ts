import type { MetricSeries } from "@infrawrench/plugin-base";
import type { ResendContext } from "./api.js";
import { resendFetch } from "./api.js";

/**
 * Deliverability metrics from `GET /emails/metrics`
 * (https://resend.com/docs/api-reference/emails/get-metrics): counts and
 * rates bucketed by `granularity` when `period` is a dimension, filterable by
 * `domain_id` or `broadcast_id`. Responses are cached by Resend for up to 15
 * minutes, and history is clamped to the plan's retention window. Open and
 * click counts need tracking on the sending domain.
 */
const COUNTS: Array<[string, string]> = [
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["delivery_delayed", "Delivery delayed"],
  ["bounced_permanent", "Hard bounces"],
  ["bounced_transient", "Soft bounces"],
  ["complained", "Spam complaints"],
  ["failed", "Failed"],
  ["suppressed", "Suppressed"],
  ["unique_opened", "Unique opens"],
  ["unique_clicked", "Unique clicks"],
  ["unsubscribed", "Unsubscribes"],
];

const RATES: Array<[string, string]> = [
  ["delivery_rate", "Delivery rate"],
  ["bounce_rate", "Bounce rate"],
  ["complaint_rate", "Complaint rate"],
  ["open_rate", "Open rate"],
  ["click_rate", "Click rate"],
];

interface MetricsResponse {
  data?: Array<Record<string, unknown> & { period?: string }>;
  totals?: Record<string, number>;
}

export interface MetricsScope {
  domainId?: string;
  broadcastId?: string;
}

export async function emailMetrics(
  ctx: ResendContext,
  startMs: number,
  endMs: number,
  scope: MetricsScope = {},
): Promise<MetricSeries[]> {
  const hourly = endMs - startMs <= 2 * 86_400_000;
  const res = await resendFetch<MetricsResponse>(ctx, "/emails/metrics", {
    query: {
      start_date: new Date(startMs).toISOString(),
      end_date: new Date(endMs).toISOString(),
      granularity: hourly ? "hourly" : "daily",
      dimensions: ["period"],
      metrics: [...COUNTS, ...RATES].map(([k]) => k),
      timezone: "UTC",
      ...(scope.domainId ? { domain_id: [scope.domainId] } : {}),
      ...(scope.broadcastId ? { broadcast_id: [scope.broadcastId] } : {}),
    },
  });
  const rows = (res?.data ?? [])
    .map((row) => ({ row, ts: Date.parse(String(row.period ?? "")) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) return [];
  const series = (key: string, label: string, unit: string, scale = 1): MetricSeries => ({
    label,
    unit,
    points: rows.map(({ row, ts }) => {
      const v = Number(row[key] ?? 0);
      return { timestamp: ts, value: Number.isFinite(v) ? v * scale : 0 };
    }),
  });
  // Rates come back as fractions (`delivered / sent`); chart them as percent.
  const rateScale = rows.some(({ row }) => RATES.some(([k]) => Number(row[k]) > 1)) ? 1 : 100;
  return [
    ...COUNTS.map(([k, label]) => series(k, label, "emails")),
    ...RATES.map(([k, label]) => series(k, label, "%", rateScale)),
  ];
}

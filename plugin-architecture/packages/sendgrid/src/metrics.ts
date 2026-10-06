/**
 * Daily email metrics from SendGrid's Stats API: `GET /v3/stats` for the
 * account and `GET /v3/subusers/stats?subusers=` for one subuser, both with
 * `aggregated_by=day`. Each day is `{ date, stats: [{ metrics }] }`; the
 * subuser form carries one entry per subuser, so entries are summed.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { SendGridContext } from "./api.js";
import { sendgridFetch } from "./api.js";

export const METRICS_WINDOW_MS = 30 * 24 * 3600_000;

export function rangeOrDefault(timeRange: { startMs: number; endMs: number } | undefined): {
  startMs: number;
  endMs: number;
} {
  if (timeRange) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - METRICS_WINDOW_MS, endMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type SgMetrics = Partial<
  Record<
    | "requests"
    | "processed"
    | "delivered"
    | "deferred"
    | "bounces"
    | "bounce_drops"
    | "blocks"
    | "invalid_emails"
    | "spam_reports"
    | "spam_report_drops"
    | "unsubscribes"
    | "unsubscribe_drops"
    | "opens"
    | "unique_opens"
    | "clicks"
    | "unique_clicks",
    number
  >
>;

export interface SgStatDay {
  date?: string;
  stats?: Array<{ metrics?: SgMetrics; name?: string }>;
}

const SERIES: Array<{ label: string; keys: Array<keyof SgMetrics>; unit: string }> = [
  { label: "Requests", keys: ["requests"], unit: "emails" },
  { label: "Delivered", keys: ["delivered"], unit: "emails" },
  { label: "Deferred", keys: ["deferred"], unit: "emails" },
  { label: "Bounces", keys: ["bounces"], unit: "emails" },
  { label: "Blocks", keys: ["blocks"], unit: "emails" },
  {
    label: "Dropped",
    keys: ["bounce_drops", "spam_report_drops", "unsubscribe_drops", "invalid_emails"],
    unit: "emails",
  },
  { label: "Spam reports", keys: ["spam_reports"], unit: "emails" },
  { label: "Unsubscribes", keys: ["unsubscribes"], unit: "emails" },
  { label: "Unique opens", keys: ["unique_opens"], unit: "opens" },
  { label: "Unique clicks", keys: ["unique_clicks"], unit: "clicks" },
];

/** Sum the per-entry metrics of one day. */
export function dayTotals(d: SgStatDay): SgMetrics {
  const out: SgMetrics = {};
  for (const s of d.stats ?? []) {
    for (const [k, v] of Object.entries(s.metrics ?? {})) {
      const key = k as keyof SgMetrics;
      if (typeof v === "number") out[key] = (out[key] ?? 0) + v;
    }
  }
  return out;
}

export function seriesFromDays(days: SgStatDay[]): MetricSeries[] {
  const rows = days
    .filter((d) => d.date)
    .map((d) => ({ ts: Date.parse(`${d.date}T00:00:00Z`), m: dayTotals(d) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) return [];
  return SERIES.map((s) => ({
    label: s.label,
    unit: s.unit,
    points: rows.map((r) => ({
      timestamp: r.ts,
      value: s.keys.reduce((sum, k) => sum + (r.m[k] ?? 0), 0),
    })),
  }));
}

export async function statDays(
  ctx: SendGridContext,
  range: { startMs: number; endMs: number },
  subuser?: string,
): Promise<SgStatDay[]> {
  const query = {
    start_date: day(range.startMs),
    end_date: day(range.endMs),
    aggregated_by: "day",
  };
  const res = subuser
    ? await sendgridFetch<SgStatDay[]>(ctx, "/v3/subusers/stats", {
        query: { ...query, subusers: subuser },
        asParent: true,
      })
    : await sendgridFetch<SgStatDay[]>(ctx, "/v3/stats", { query });
  return Array.isArray(res) ? res : [];
}

/** Totals over a set of days, for the detail pages and dashboard stats. */
export function sumDays(days: SgStatDay[]): SgMetrics {
  const out: SgMetrics = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(dayTotals(d))) {
      const key = k as keyof SgMetrics;
      out[key] = (out[key] ?? 0) + (v ?? 0);
    }
  }
  return out;
}

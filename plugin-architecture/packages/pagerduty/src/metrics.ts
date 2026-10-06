/**
 * Incident metrics from PagerDuty Analytics
 * (`POST /analytics/metrics/incidents/services`): incident counts, mean time
 * to acknowledge, mean time to resolve, uptime and interruptions, per service.
 * With `aggregate_unit: "day"` each row carries `range_start`; without it the
 * single row is the window's total, which the detail page shows.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PagerDutyTransport } from "./api.js";
import { pdFetch } from "./api.js";

export const METRICS_WINDOW_MS = 30 * 24 * 3600_000;

export interface ServiceAnalyticsRow {
  range_start?: string;
  service_id?: string;
  total_incident_count?: number;
  total_incidents_acknowledged?: number;
  total_incidents_auto_resolved?: number;
  total_escalation_count?: number;
  mean_seconds_to_first_ack?: number | null;
  mean_seconds_to_resolve?: number | null;
  up_time_pct?: number | null;
  total_interruptions?: number;
  total_off_hour_interruptions?: number;
  total_sleep_hour_interruptions?: number;
  total_notifications?: number;
}

export function rangeOrDefault(timeRange: { startMs: number; endMs: number } | undefined): {
  startMs: number;
  endMs: number;
} {
  if (timeRange) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - METRICS_WINDOW_MS, endMs };
}

export async function serviceAnalytics(
  transport: PagerDutyTransport,
  serviceId: string,
  range: { startMs: number; endMs: number },
  aggregateUnit?: "day" | "week",
): Promise<ServiceAnalyticsRow[]> {
  const res = await pdFetch<{ data?: ServiceAnalyticsRow[] }>(
    transport,
    "/analytics/metrics/incidents/services",
    {
      body: {
        filters: {
          created_at_start: new Date(range.startMs).toISOString(),
          created_at_end: new Date(range.endMs).toISOString(),
          service_ids: [serviceId],
        },
        time_zone: "Etc/UTC",
        ...(aggregateUnit ? { aggregate_unit: aggregateUnit } : {}),
      },
    },
  );
  return res?.data ?? [];
}

interface SeriesSpec {
  label: string;
  unit: string;
  value: (row: ServiceAnalyticsRow) => number | null | undefined;
}

const SPECS: SeriesSpec[] = [
  { label: "Incidents", unit: "incidents", value: (r) => r.total_incident_count },
  {
    label: "Mean time to acknowledge",
    unit: "min",
    value: (r) =>
      typeof r.mean_seconds_to_first_ack === "number" ? r.mean_seconds_to_first_ack / 60 : null,
  },
  {
    label: "Mean time to resolve",
    unit: "min",
    value: (r) =>
      typeof r.mean_seconds_to_resolve === "number" ? r.mean_seconds_to_resolve / 60 : null,
  },
  { label: "Uptime", unit: "%", value: (r) => r.up_time_pct },
  { label: "Escalations", unit: "escalations", value: (r) => r.total_escalation_count },
  {
    label: "Off-hours interruptions",
    unit: "interruptions",
    value: (r) => r.total_off_hour_interruptions,
  },
  {
    label: "Sleep-hours interruptions",
    unit: "interruptions",
    value: (r) => r.total_sleep_hour_interruptions,
  },
];

/** Daily rows → one series per metric. A metric with no value on a day has no point that day. */
export function seriesFromRows(rows: ServiceAnalyticsRow[]): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const spec of SPECS) {
    const points = rows
      .filter((r) => typeof r.range_start === "string")
      .map((r) => ({ timestamp: Date.parse(String(r.range_start)), value: spec.value(r) }))
      .filter(
        (p): p is { timestamp: number; value: number } =>
          Number.isFinite(p.timestamp) && typeof p.value === "number" && Number.isFinite(p.value),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    if (points.length > 0) out.push({ label: spec.label, unit: spec.unit, points });
  }
  return out;
}

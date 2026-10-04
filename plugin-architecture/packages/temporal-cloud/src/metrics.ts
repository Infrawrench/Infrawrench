/**
 * Namespace metrics from the Temporal Cloud OpenMetrics endpoint
 * (`GET https://metrics.temporal.io/v1/metrics`, Bearer API key; reference at
 * https://docs.temporal.io/cloud/metrics/openmetrics/api-reference).
 *
 * The endpoint is a scrape target, not a query API: each call returns only the
 * most recently completed one-minute window (offset about three minutes for
 * data latency), every metric a gauge, rates already per second. There is no
 * history to ask for, so `fetchMetricSeries` returns one point per series and
 * the host's metric store builds the history for pinned namespaces from
 * successive reads. The account-wide limit is 180 requests an hour, so one
 * scrape (all namespaces, only the metrics charted here) is shared by every
 * namespace of the account for a minute.
 *
 * The legacy PromQL endpoint (mTLS client certificates, `temporal_cloud_v0_*`)
 * is not used: it was deprecated in April 2026 and is disabled on
 * 2026-10-05. Neither endpoint publishes a workflow-task schedule-to-start
 * latency; the closest signals offered are the task backlog, tasks that found
 * no poller, and the schedule start delay.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { TemporalContext } from "./api.js";
import { METRICS_API_BASE, buildQuery, fetchText } from "./api.js";

export const METRICS_WINDOW_MS = 60 * 60 * 1000;

interface SeriesSpec {
  metric: string;
  label: string;
  unit?: string;
  /** How samples from different label sets combine. */
  agg: "sum" | "max";
  scale?: number;
}

const SECONDS_TO_MS = 1000;

export const NAMESPACE_SERIES: SeriesSpec[] = [
  { metric: "temporal_cloud_v1_total_action_count", label: "Actions/s", unit: "/s", agg: "sum" },
  {
    metric: "temporal_cloud_v1_billable_action_count",
    label: "Billable actions/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_action_limit",
    label: "Actions/s limit",
    unit: "/s",
    agg: "max",
  },
  {
    metric: "temporal_cloud_v1_total_action_throttled_count",
    label: "Throttled actions/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_success_count",
    label: "Workflows succeeded/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_failed_count",
    label: "Workflows failed/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_timeout_count",
    label: "Workflows timed out/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_cancel_count",
    label: "Workflows canceled/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_terminate_count",
    label: "Workflows terminated/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_namespace_open_workflows",
    label: "Open workflows",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_activity_fail_count",
    label: "Activities failed/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_workflow_schedule_to_close_latency_p95",
    label: "Workflow schedule-to-close p95",
    unit: "ms",
    agg: "max",
    scale: SECONDS_TO_MS,
  },
  {
    metric: "temporal_cloud_v1_service_latency_p95",
    label: "Service latency p95 (slowest operation)",
    unit: "ms",
    agg: "max",
    scale: SECONDS_TO_MS,
  },
  {
    metric: "temporal_cloud_v1_service_latency_p99",
    label: "Service latency p99 (slowest operation)",
    unit: "ms",
    agg: "max",
    scale: SECONDS_TO_MS,
  },
  {
    metric: "temporal_cloud_v1_service_error_count",
    label: "Service errors/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_approximate_backlog_count",
    label: "Task backlog",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_no_poller_tasks_count",
    label: "Tasks with no poller/s",
    unit: "/s",
    agg: "sum",
  },
  {
    metric: "temporal_cloud_v1_schedule_action_e2e_delay_p95",
    label: "Schedule start delay p95",
    unit: "ms",
    agg: "max",
    scale: SECONDS_TO_MS,
  },
  {
    metric: "temporal_cloud_v1_replication_lag_p95",
    label: "Replication lag p95",
    unit: "ms",
    agg: "max",
    scale: SECONDS_TO_MS,
  },
];

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
  timestampMs?: number;
}

const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Parse OpenMetrics / Prometheus text exposition into samples. */
export function parseOpenMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    let name: string;
    let labelText = "";
    let rest: string;
    if (brace >= 0 && brace < (line.indexOf(" ") === -1 ? Infinity : line.indexOf(" "))) {
      const close = line.lastIndexOf("}");
      if (close < brace) continue;
      name = line.slice(0, brace);
      labelText = line.slice(brace + 1, close);
      rest = line.slice(close + 1).trim();
    } else {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }
    const [valueText, tsText] = rest.split(/\s+/);
    const value = Number(valueText);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const m of labelText.matchAll(LABEL_RE)) {
      labels[m[1] as string] = (m[2] as string).replace(/\\(.)/g, (_, c: string) =>
        c === "n" ? "\n" : c,
      );
    }
    const ts = tsText !== undefined ? Number(tsText) : NaN;
    out.push({
      name,
      labels,
      value,
      // OpenMetrics timestamps are seconds; Temporal's examples show
      // milliseconds. Anything past 1e11 can only be milliseconds.
      ...(Number.isFinite(ts) ? { timestampMs: ts > 1e11 ? ts : ts * 1000 } : {}),
    });
  }
  return out;
}

/** One cached scrape per metrics key, shared by every namespace for a minute. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; samples: Promise<Sample[]> }>();

export function clearMetricsCache(): void {
  cache.clear();
}

export class MetricsAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MetricsAccessError";
  }
}

export async function scrapeMetrics(ctx: TemporalContext): Promise<Sample[]> {
  const now = Date.now();
  const hit = cache.get(ctx.metricsApiKey);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.samples;
  const samples = (async () => {
    const res = await fetchText(
      ctx,
      `${METRICS_API_BASE}/v1/metrics${buildQuery({ metrics: NAMESPACE_SERIES.map((s) => s.metric) })}`,
      {
        Authorization: `Bearer ${ctx.metricsApiKey}`,
        Accept: "application/openmetrics-text, text/plain",
      },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new MetricsAccessError(
        res.status === 401 || res.status === 403
          ? "The metrics endpoint refused this API key. It needs a service account key with the Metrics Read-Only role (or an admin role); add one as the Metrics API key on the account."
          : `Temporal Cloud metrics endpoint answered HTTP ${res.status}`,
        res.status,
      );
    }
    return parseOpenMetrics(res.body);
  })();
  cache.set(ctx.metricsApiKey, { at: now, samples });
  samples.catch(() => cache.delete(ctx.metricsApiKey));
  return samples;
}

/** The `temporal_namespace` label carries the namespace name or its full id. */
export function matchesNamespace(label: string | undefined, namespaceId: string): boolean {
  if (!label) return false;
  return label === namespaceId || label === namespaceId.split(".")[0];
}

export function namespaceSeries(samples: Sample[], namespaceId: string): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const spec of NAMESPACE_SERIES) {
    const matched = samples.filter(
      (s) =>
        s.name === spec.metric && matchesNamespace(s.labels["temporal_namespace"], namespaceId),
    );
    if (matched.length === 0) continue;
    const values = matched.map((s) => s.value * (spec.scale ?? 1));
    const value = spec.agg === "sum" ? values.reduce((a, b) => a + b, 0) : Math.max(...values);
    const timestamp = Math.max(...matched.map((s) => s.timestampMs ?? Date.now()));
    out.push({
      label: spec.label,
      ...(spec.unit ? { unit: spec.unit } : {}),
      points: [{ timestamp, value }],
    });
  }
  return out;
}

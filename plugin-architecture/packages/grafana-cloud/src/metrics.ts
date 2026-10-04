/**
 * Metric series for the Metrics tab.
 *
 * - Organization: the monthly bill by product, one billed-usage request per
 *   month in the window (at most 12, which is all the history Grafana keeps).
 * - Stack: Grafana Cloud's usage metrics (the `grafanacloud_*` series behind
 *   the `grafanacloud-usage` data source every stack has), filtered to the
 *   stack's own metrics, logs and traces instances by their `id` label. Read
 *   through the stack's own data source proxy when the stack is connected
 *   (a service account token can query it), otherwise straight from the
 *   billing Prometheus endpoint with the access policy token, which needs the
 *   `billing-metrics:read` scope.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { GrafanaContext } from "./api.js";
import { GrafanaApiError, stackFetch } from "./api.js";
import { fetchBilledUsage, monthStartsInRange } from "./cost-data.js";
import type { GfDatasource } from "./types.js";

export const STACK_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BILL_METRICS_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** The billing Prometheus endpoint the `grafanacloud-usage` data source points at. */
export const USAGE_PROM_URL = "https://billing.grafana.net/api/prom";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

// ---------------------------------------------------------------------------
// Organization: monthly bill
// ---------------------------------------------------------------------------

export async function billSeries(
  ctx: GrafanaContext,
  orgSlug: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(range.startMs).toISOString().slice(0, 7) + "-01";
  const to = new Date(range.endMs).toISOString().slice(0, 10);
  const months = monthStartsInRange(from, to, today).slice(-12);
  const byProduct = new Map<string, MetricSeriesPoint[]>();
  const total: MetricSeriesPoint[] = [];
  for (const month of months) {
    const items = await fetchBilledUsage(ctx, orgSlug, month);
    const timestamp = Date.parse(`${month}T00:00:00Z`);
    let sum = 0;
    for (const item of items) {
      const product = item.dimensionName || item.dimensionId || "Other";
      const amount = item.amountDue ?? 0;
      sum += amount;
      const points = byProduct.get(product) ?? [];
      points.push({ timestamp, value: amount });
      byProduct.set(product, points);
    }
    total.push({ timestamp, value: Math.round(sum * 100) / 100 });
  }
  const out: MetricSeries[] = [];
  if (total.length > 0) out.push({ label: "Billed (total)", unit: "USD", points: total });
  for (const [product, points] of [...byProduct.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (points.every((p) => p.value === 0)) continue;
    out.push({ label: product, unit: "USD", points });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stack: usage metrics
// ---------------------------------------------------------------------------

interface PromRangeResponse {
  status?: string;
  data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> };
}

/** Where a stack's usage queries go. */
export type UsageSource =
  | { kind: "proxy"; stackUrl: string; saToken: string; datasourceUid: string }
  | { kind: "billing"; orgId: string };

export async function resolveUsageSource(
  ctx: GrafanaContext,
  stack: { url: string; saToken?: string | null; orgId?: string },
): Promise<UsageSource | null> {
  if (stack.saToken && stack.url) {
    const sources = await stackFetch<GfDatasource[]>(
      ctx,
      stack.url,
      stack.saToken,
      "/api/datasources",
    ).catch(() => [] as GfDatasource[]);
    const usage = sources.find((d) => d.name === "grafanacloud-usage" && d.uid);
    if (usage?.uid) {
      return {
        kind: "proxy",
        stackUrl: stack.url,
        saToken: stack.saToken,
        datasourceUid: usage.uid,
      };
    }
  }
  if (stack.orgId) return { kind: "billing", orgId: stack.orgId };
  return null;
}

function stepFor(range: TimeRange): number {
  return Math.max(60, Math.ceil((range.endMs - range.startMs) / 1000 / 240));
}

async function queryRange(
  ctx: GrafanaContext,
  source: UsageSource,
  promql: string,
  range: TimeRange,
): Promise<PromRangeResponse> {
  const params = new URLSearchParams({
    query: promql,
    start: String(Math.floor(range.startMs / 1000)),
    end: String(Math.floor(range.endMs / 1000)),
    step: String(stepFor(range)),
  });
  if (source.kind === "proxy") {
    return stackFetch<PromRangeResponse>(
      ctx,
      source.stackUrl,
      source.saToken,
      `/api/datasources/proxy/uid/${encodeURIComponent(source.datasourceUid)}/api/v1/query_range?${params.toString()}`,
    );
  }
  const basic = btoaUtf8(`${source.orgId}:${ctx.token}`);
  try {
    return await jsonRestFetch<PromRangeResponse>({
      vendor: "Grafana usage metrics",
      url: `${USAGE_PROM_URL}/api/v1/query_range?${params.toString()}`,
      errorPath: "/api/prom/api/v1/query_range",
      headers: { Accept: "application/json", Authorization: `Basic ${basic}` },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const status = Number(/API error (\d{3})/.exec(String(err))?.[1] ?? 0);
    if (status) throw new GrafanaApiError(status, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function btoaUtf8(value: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(value);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(value, "utf8").toString("base64");
}

function toSeries(res: PromRangeResponse, label: string, unit: string, scale = 1): MetricSeries[] {
  return (res.data?.result ?? [])
    .map((r): MetricSeries => {
      const points: MetricSeriesPoint[] = [];
      for (const [ts, raw] of r.values ?? []) {
        const value = Number(raw);
        if (Number.isFinite(value)) points.push({ timestamp: ts * 1000, value: value * scale });
      }
      return { label, unit, points };
    })
    .filter((s) => s.points.length > 0);
}

export interface StackMetricIds {
  promInstanceId?: string;
  logsInstanceId?: string;
  tracesInstanceId?: string;
}

/** The PromQL behind each stack chart. Exported for tests. */
export function stackQueries(ids: StackMetricIds): Array<{
  label: string;
  unit: string;
  promql: string;
  scale?: number;
}> {
  const out: Array<{ label: string; unit: string; promql: string; scale?: number }> = [];
  const sel = (id: string) => `{id="${id.replace(/["\\]/g, "")}"}`;
  if (ids.promInstanceId) {
    const s = sel(ids.promInstanceId);
    out.push(
      {
        label: "Active series",
        unit: "series",
        promql: `sum(grafanacloud_instance_active_series${s})`,
      },
      {
        label: "Samples ingested",
        unit: "samples/s",
        promql: `sum(grafanacloud_instance_samples_per_second${s})`,
      },
      {
        label: "Samples discarded",
        unit: "samples/s",
        promql: `sum(grafanacloud_instance_samples_discarded_per_second${s})`,
      },
    );
  }
  if (ids.logsInstanceId) {
    const s = sel(ids.logsInstanceId);
    out.push(
      {
        label: "Logs ingested",
        unit: "MB/s",
        promql: `sum(grafanacloud_logs_instance_bytes_received_per_second${s})`,
        scale: 1 / 1_000_000,
      },
      {
        label: "Active log streams",
        unit: "streams",
        promql: `sum(grafanacloud_logs_instance_active_streams${s})`,
      },
    );
  }
  if (ids.tracesInstanceId) {
    out.push({
      label: "Traces ingested",
      unit: "MB/s",
      promql: `sum(grafanacloud_traces_instance_bytes_received_per_second${sel(ids.tracesInstanceId)})`,
      scale: 1 / 1_000_000,
    });
  }
  return out;
}

export async function stackUsageSeries(
  ctx: GrafanaContext,
  source: UsageSource,
  ids: StackMetricIds,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const queries = stackQueries(ids);
  const settled = await Promise.allSettled(
    queries.map((q) => queryRange(ctx, source, q.promql, range)),
  );
  const out: MetricSeries[] = [];
  settled.forEach((r, i) => {
    const q = queries[i];
    if (r.status === "fulfilled" && q)
      out.push(...toSeries(r.value, q.label, q.unit, q.scale ?? 1));
  });
  if (out.length === 0) {
    const firstError = settled.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    if (firstError) throw firstError.reason;
  }
  return out;
}

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { DynatraceContext } from "./api.js";
import { envFetch, statusOf } from "./api.js";

/** The window `fetchMetricSeries` charts when the host passes no range. */
export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MetricSpec {
  /** Metric selector, optionally with transformations. */
  selector: string;
  label: string;
  unit?: string;
  /** Multiplier applied to every value (e.g. microseconds → milliseconds). */
  scale?: number;
}

/**
 * Built-in metric keys per resource type. Each is queried on its own, so a
 * metric the environment does not have (no RUM licence, a host in
 * infrastructure-only mode) drops out instead of failing the whole tab.
 */
export const METRICS: Record<string, MetricSpec[]> = {
  host: [
    { selector: "builtin:host.cpu.usage", label: "CPU usage", unit: "%" },
    { selector: "builtin:host.mem.usage", label: "Memory usage", unit: "%" },
    { selector: "builtin:host.disk.usedPct:max:splitBy()", label: "Fullest disk", unit: "%" },
    {
      selector: "builtin:host.net.nic.trafficIn:splitBy()",
      label: "Network in",
      unit: "bit/s",
    },
    {
      selector: "builtin:host.net.nic.trafficOut:splitBy()",
      label: "Network out",
      unit: "bit/s",
    },
  ],
  service: [
    {
      selector: "builtin:service.response.time:avg",
      label: "Response time",
      unit: "ms",
      scale: 0.001,
    },
    { selector: "builtin:service.requestCount.server", label: "Requests", unit: "count" },
    { selector: "builtin:service.errors.total.rate", label: "Failure rate", unit: "%" },
  ],
  application: [
    {
      selector: "builtin:apps.web.actionCount.category:splitBy()",
      label: "User actions",
      unit: "count",
    },
    {
      selector: "builtin:apps.web.action.speedIndex.load.browser:avg:splitBy()",
      label: "Speed index",
      unit: "ms",
    },
  ],
  "synthetic-monitor-HTTP": [
    {
      selector: "builtin:synthetic.http.availability.location.total:splitBy()",
      label: "Availability",
      unit: "%",
    },
  ],
  "synthetic-monitor-BROWSER": [
    {
      selector: "builtin:synthetic.browser.availability.location.total:splitBy()",
      label: "Availability",
      unit: "%",
    },
  ],
};

/** A resolution that keeps a chart around 120 points. */
export function resolutionFor(windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000 / 120));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

interface MetricQueryResponse {
  result?: Array<{
    metricId?: string;
    data?: Array<{
      dimensionMap?: Record<string, string>;
      timestamps?: number[];
      values?: Array<number | null>;
    }>;
  }>;
}

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs = METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** `GET /api/v2/metrics/query` for one metric, scoped to one entity. */
export async function querySeries(
  ctx: DynatraceContext,
  spec: MetricSpec,
  entitySelector: string,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const res = await envFetch<MetricQueryResponse>(ctx, "/api/v2/metrics/query", {
    query: {
      metricSelector: spec.selector,
      entitySelector,
      from: range.startMs,
      to: range.endMs,
      resolution: resolutionFor(range.endMs - range.startMs),
    },
  });
  const out: MetricSeries[] = [];
  for (const result of res?.result ?? []) {
    const data = result.data ?? [];
    for (const d of data) {
      const points = (d.timestamps ?? [])
        .map((timestamp, i) => ({ timestamp, value: d.values?.[i] }))
        .filter((p): p is { timestamp: number; value: number } => typeof p.value === "number")
        .map((p) => ({ timestamp: p.timestamp, value: p.value * (spec.scale ?? 1) }));
      const dims = Object.entries(d.dimensionMap ?? {})
        .filter(([k]) => !k.startsWith("dt.entity."))
        .map(([, v]) => v);
      out.push({
        label: data.length > 1 && dims.length ? `${spec.label} (${dims.join(", ")})` : spec.label,
        ...(spec.unit ? { unit: spec.unit } : {}),
        points,
      });
    }
  }
  return out;
}

/** Every metric of `specs` for one entity; metrics the environment lacks are skipped. */
export async function entitySeries(
  ctx: DynatraceContext,
  specs: MetricSpec[],
  entityId: string,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const selector = `entityId("${entityId.replace(/"/g, "")}")`;
  const results = await Promise.all(
    specs.map(async (spec) => {
      try {
        return await querySeries(ctx, spec, selector, range);
      } catch (err) {
        const status = statusOf(err);
        if (status === 400 || status === 404) return [];
        throw err;
      }
    }),
  );
  return results.flat();
}

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { ChronoContext } from "./api.js";
import { ChronoApiError, chronoFetch } from "./api.js";

/** Prometheus HTTP API on the tenant: `/data/metrics/api/v1/{query,query_range}`. */
export const PROM_PATH = "/data/metrics/api/v1";
export const METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_SERIES = 20;

interface PromResponse {
  status?: string;
  error?: string;
  data?: {
    resultType?: string;
    result?: Array<{
      metric?: Record<string, string>;
      values?: Array<[number, string]>;
      value?: [number, string];
    }>;
  };
}

function check(res: PromResponse): NonNullable<PromResponse["data"]> {
  if (res?.status && res.status !== "success") {
    throw new ChronoApiError(400, `PromQL error: ${res.error ?? res.status}`);
  }
  return res?.data ?? {};
}

export function seriesLabel(metric: Record<string, string> | undefined): string {
  const m = metric ?? {};
  const name = m["__name__"] ?? "";
  const labels = Object.entries(m)
    .filter(([k]) => k !== "__name__")
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
  return `${name}${labels ? `{${labels}}` : ""}` || "value";
}

/** About 120 points per chart, in whole seconds. */
export function stepFor(windowMs: number): number {
  return Math.max(15, Math.round(windowMs / 1000 / 120));
}

export async function queryRange(
  ctx: ChronoContext,
  query: string,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const data = check(
    await chronoFetch<PromResponse>(ctx, `${PROM_PATH}/query_range`, {
      query: {
        query,
        start: Math.floor(range.startMs / 1000),
        end: Math.floor(range.endMs / 1000),
        step: stepFor(range.endMs - range.startMs),
      },
    }),
  );
  return (data.result ?? []).slice(0, MAX_SERIES).map((r) => ({
    label: seriesLabel(r.metric),
    points: (r.values ?? [])
      .map(([t, v]) => ({ timestamp: t * 1000, value: Number(v) }))
      .filter((p) => Number.isFinite(p.value)),
  }));
}

/** Instant query, flattened into table rows for the Query tab. */
export async function instantQuery(
  ctx: ChronoContext,
  query: string,
): Promise<Record<string, unknown>[]> {
  const data = check(
    await chronoFetch<PromResponse>(ctx, `${PROM_PATH}/query`, { query: { query } }),
  );
  if (data.resultType === "scalar" || data.resultType === "string") {
    const v = (data.result as unknown as [number, string]) ?? [];
    return [{ timestamp: new Date((v[0] ?? 0) * 1000).toISOString(), value: v[1] }];
  }
  return (data.result ?? []).slice(0, 1000).map((r) => {
    const sample = r.value ?? r.values?.[r.values.length - 1];
    return {
      ...(r.metric ?? {}),
      value: sample ? Number(sample[1]) : null,
      timestamp: sample ? new Date(sample[0] * 1000).toISOString() : null,
    };
  });
}

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs = METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

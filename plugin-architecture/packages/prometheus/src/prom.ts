import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PromContext } from "./api.js";
import { promFetch } from "./api.js";

export const METRICS_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_SERIES = 20;
/** Prometheus refuses range queries over 11,000 points per series. */
const MAX_POINTS = 11_000;

export interface PromSample {
  metric?: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

export interface PromQueryData {
  resultType?: "matrix" | "vector" | "scalar" | "string";
  result?: PromSample[] | [number, string];
}

export function seriesLabel(
  metric: Record<string, string> | undefined,
  fallback = "value",
): string {
  const m = metric ?? {};
  const name = m["__name__"] ?? "";
  const labels = Object.entries(m)
    .filter(([k]) => k !== "__name__")
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
  return `${name}${labels ? `{${labels}}` : ""}` || fallback;
}

/** About 120 points per chart, in whole seconds. */
export function stepFor(windowMs: number): number {
  return Math.max(15, Math.round(windowMs / 1000 / 120));
}

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs = METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

export async function queryRangeRaw(
  ctx: PromContext,
  query: string,
  startS: number,
  endS: number,
  stepS: number,
): Promise<PromSample[]> {
  const data = await promFetch<PromQueryData>(ctx, "/api/v1/query_range", {
    method: "POST",
    form: true,
    query: { query, start: startS, end: endS, step: stepS },
  });
  return Array.isArray(data?.result) && typeof data.result[0] !== "number"
    ? (data.result as PromSample[])
    : [];
}

/** A range query charted as up to {@link MAX_SERIES} series. `label` names a single-series result. */
export async function queryRange(
  ctx: PromContext,
  query: string,
  range: { startMs: number; endMs: number },
  label?: string,
  unit?: string,
): Promise<MetricSeries[]> {
  const windowMs = range.endMs - range.startMs;
  const step = Math.max(stepFor(windowMs), Math.ceil(windowMs / 1000 / MAX_POINTS));
  const result = await queryRangeRaw(
    ctx,
    query,
    Math.floor(range.startMs / 1000),
    Math.floor(range.endMs / 1000),
    step,
  );
  return result.slice(0, MAX_SERIES).map((r) => ({
    label:
      label && result.length === 1
        ? label
        : label
          ? `${label} ${seriesLabel(r.metric, "")}`.trim()
          : seriesLabel(r.metric),
    ...(unit ? { unit } : {}),
    points: (r.values ?? [])
      .map(([t, v]) => ({ timestamp: t * 1000, value: Number(v) }))
      .filter((p) => Number.isFinite(p.value)),
  }));
}

/** Instant query, flattened into table rows for the Query tab. */
export async function instantQuery(
  ctx: PromContext,
  query: string,
  time?: number,
): Promise<Record<string, unknown>[]> {
  const data = await promFetch<PromQueryData>(ctx, "/api/v1/query", {
    method: "POST",
    form: true,
    query: { query, ...(time !== undefined ? { time } : {}) },
  });
  if (data?.resultType === "scalar" || data?.resultType === "string") {
    const v = (data.result as [number, string]) ?? [];
    return [{ timestamp: new Date((v[0] ?? 0) * 1000).toISOString(), value: v[1] }];
  }
  const rows = (data?.result as PromSample[] | undefined) ?? [];
  if (data?.resultType === "matrix") {
    return rows.slice(0, 200).flatMap((r) =>
      (r.values ?? []).slice(-50).map(([t, v]) => ({
        ...(r.metric ?? {}),
        value: Number(v),
        timestamp: new Date(t * 1000).toISOString(),
      })),
    );
  }
  return rows.slice(0, 5000).map((r) => {
    const sample = r.value;
    return {
      ...(r.metric ?? {}),
      value: sample ? Number(sample[1]) : null,
      timestamp: sample ? new Date(sample[0] * 1000).toISOString() : null,
    };
  });
}

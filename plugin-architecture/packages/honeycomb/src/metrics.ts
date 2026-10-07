/**
 * Metric series for the Metrics tab.
 *
 * - Environments: one environment-wide (`__all__`) COUNT in usage mode, which
 *   counts the events Honeycomb actually stored (no sample-rate correction):
 *   the volume Honeycomb bills on.
 * - Datasets: one query carrying COUNT, P50/P95/P99 of the dataset's duration
 *   column and the average of an ad hoc calculated field that is 1 when the
 *   error column is set, so error rate costs no extra run.
 * - Triggers and saved queries: their own stored query re-run over the
 *   selected range, plus the trigger's threshold as a flat line.
 * - SLOs: `GET /1/slos/{dataset}/{id}/counts/history`, hourly good/total
 *   counts, which is not a query run and so does not touch the query limit.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { HoneycombContext } from "./api.js";
import { ds, v1 } from "./api.js";
import type { SeriesSpec, TimeRange } from "./query.js";
import {
  calculationKey,
  clampQueryRange,
  granularityFor,
  respec,
  resultSeries,
  runQuery,
  specSeries,
} from "./query.js";
import { ALL_DATASETS } from "./resource-types.js";
import type { HnyQuerySpec, HnySloHistory } from "./types.js";

export { DEFAULT_METRICS_WINDOW_MS, rangeOrDefault } from "./query.js";
export const SLO_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A column reference in a calculated-field expression. */
export function columnRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? `$${name}` : `$"${name.replace(/"/g, '\\"')}"`;
}

function window(range: TimeRange): Pick<HnyQuerySpec, "start_time" | "end_time" | "granularity"> {
  return {
    start_time: Math.floor(range.startMs / 1000),
    end_time: Math.floor(range.endMs / 1000),
    granularity: granularityFor(range),
  };
}

export async function environmentSeries(
  ctx: HoneycombContext,
  key: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const r = clampQueryRange(range);
  const result = await runQuery(ctx, key, ALL_DATASETS, {
    calculations: [{ op: "COUNT" }],
    usage_mode: true,
    ...window(r),
  });
  return resultSeries(result, [{ key: "COUNT", label: "Events stored", unit: "events" }]);
}

export async function datasetSeries(
  ctx: HoneycombContext,
  key: string,
  dataset: string,
  definitions: { duration?: string; error?: string },
  range: TimeRange,
): Promise<MetricSeries[]> {
  const r = clampQueryRange(range);
  const calculations: NonNullable<HnyQuerySpec["calculations"]> = [{ op: "COUNT" }];
  const wanted: SeriesSpec[] = [{ key: "COUNT", label: "Events", unit: "events" }];
  if (definitions.duration) {
    for (const op of ["P50", "P95", "P99"]) {
      const c = { op, column: definitions.duration };
      calculations.push(c);
      wanted.push({ key: calculationKey(c), label: `${op} duration`, unit: "ms" });
    }
  }
  const spec: HnyQuerySpec = { calculations, ...window(r) };
  if (definitions.error) {
    spec.calculated_fields = [
      { name: "iw_is_error", expression: `IF(EXISTS(${columnRef(definitions.error)}), 1, 0)` },
    ];
    const c = { op: "AVG", column: "iw_is_error" };
    calculations.push(c);
    wanted.push({ key: calculationKey(c), label: "Error rate", unit: "%" });
  }
  const result = await runQuery(ctx, key, dataset, spec);
  return resultSeries(result, wanted).map((s) =>
    s.label === "Error rate"
      ? { ...s, points: s.points.map((p) => ({ ...p, value: p.value * 100 })) }
      : s,
  );
}

/** Re-run a stored query (a trigger's or a saved query's) over `range`. */
export async function storedQuerySeries(
  ctx: HoneycombContext,
  key: string,
  dataset: string,
  queryId: string,
  range: TimeRange,
  threshold?: { op?: string; value?: number },
): Promise<MetricSeries[]> {
  const stored = await v1<HnyQuerySpec>(
    ctx,
    key,
    `/1/queries/${ds(dataset)}/${encodeURIComponent(queryId)}`,
  );
  const r = clampQueryRange(range);
  const spec = respec(stored, r);
  const result = await runQuery(ctx, key, dataset, spec);
  const series = resultSeries(result, specSeries(stored), stored.breakdowns ?? []);
  if (threshold && typeof threshold.value === "number" && series.length > 0) {
    const value = threshold.value;
    series.push({
      label: `Threshold (${threshold.op ?? ""} ${value})`.replace("( ", "("),
      points: [
        { timestamp: r.startMs, value },
        { timestamp: r.endMs, value },
      ],
    });
  }
  return series;
}

export async function sloSeries(
  ctx: HoneycombContext,
  key: string,
  dataset: string,
  sloId: string,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const res = await v1<HnySloHistory>(
    ctx,
    key,
    `/1/slos/${ds(dataset)}/${encodeURIComponent(sloId)}/counts/history`,
    {
      query: {
        start_time: Math.floor(range.startMs / 1000),
        end_time: Math.floor(range.endMs / 1000),
      },
    },
  );
  const sli: MetricSeries = { label: "Good events", unit: "%", points: [] };
  const total: MetricSeries = { label: "Qualified events", unit: "events", points: [] };
  const errors: MetricSeries = { label: "Failed events", unit: "events", points: [] };
  for (const b of res.buckets ?? []) {
    if (typeof b.start_time !== "number") continue;
    const ts = b.start_time * 1000;
    const t = b.total_count ?? 0;
    const e = b.error_count ?? 0;
    total.points.push({ timestamp: ts, value: t });
    errors.points.push({ timestamp: ts, value: e });
    if (t > 0) sli.points.push({ timestamp: ts, value: ((t - e) / t) * 100 });
  }
  return [sli, total, errors].filter((s) => s.points.length > 0);
}

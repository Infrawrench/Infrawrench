/**
 * Datadog metric as a business-metric source (the denominator a unit cost
 * divides by): the importer picks a metric, a scope and optionally a tag to
 * break it down by, and each run reads that series over the host's day window.
 *
 * API facts verified against Datadog's published OpenAPI documents
 * (`DataDog/datadog-api-client-typescript`, `.generator/schemas/v{1,2}/openapi.yaml`)
 * and the rollup function reference, 2026-10:
 *   - `POST /api/v2/query/timeseries` (Datadog recommends it over v1
 *     `/api/v1/query`): body `data: { type: "timeseries_request", attributes:
 *     { from, to, interval, queries: [{ data_source: "metrics", name, query }] } }`,
 *     `from` inclusive and `to` exclusive in epoch milliseconds. The answer is
 *     columnar: `data.attributes.times[]` matches each `values[i][]` 1-1, and
 *     `series[i].group_tags` names the group. The schema calls `times` seconds
 *     while its own example is milliseconds, so both are accepted here.
 *     `interval` "may be overridden by a larger interval if the query would
 *     result in too many points", which is why the bucket width is checked.
 *     Needs `timeseries_query`.
 *   - A series holds at most 1,500 points, and `.rollup(<method>, <seconds>)`
 *     buckets are aligned to UNIX time. Calendar-aligned rollups take a
 *     timezone, but they are only documented for dashboards, so this reads
 *     fixed buckets and folds them into the importer's local days itself.
 *   - `GET /api/v1/metrics?from=<epoch s>` lists metrics actively reporting
 *     since `from` (`metrics: string[]`); `GET /api/v2/metrics/{name}/all-tags`
 *     returns `data.attributes.tags` (indexed `key:value` tags), looking back
 *     `window[seconds]` (minimum and default 14,400). Both need `metrics_read`.
 *   - Metrics are retained for 15 months; days older than that come back
 *     empty and stay gaps.
 *
 * Read only by construction: every call is a read endpoint.
 */
import type {
  BusinessMetricSourceDeclaration,
  BusinessMetricSourceOption,
  BusinessMetricSourcePoint,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
} from "@infrawrench/plugin-base";
import {
  BUSINESS_METRIC_SOURCE_LIMITS,
  isBusinessMetricDay,
  isValidTimezone,
  localDayOf,
  nextBusinessMetricDay,
  withBusinessMetricTimeout,
  zonedDayStartMs,
} from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import { ddFetch } from "./api.js";

/** Points one series may hold per request; Datadog's ceiling is 1,500. */
export const DD_MAX_POINTS_PER_SERIES = 1440;
/** Options returned for one picker. */
const MAX_OPTIONS = 2000;
/** How far back the metric picker looks for actively reporting metrics. */
const METRIC_LIST_LOOKBACK_S = 7 * 86_400;
/** How far back the tag pickers look (Datadog's minimum is 14,400). */
const TAG_WINDOW_S = 7 * 86_400;

const SPACE_AGGREGATIONS = ["sum", "avg", "min", "max"] as const;
const ROLLUP_METHODS = ["sum", "avg", "min", "max", "count"] as const;

export const DATADOG_BUSINESS_METRIC_SOURCE: BusinessMetricSourceDeclaration = {
  label: "Datadog metric",
  description:
    "Read a Datadog metric, such as requests served, orders placed or a custom metric your application sends, and store one value per day.",
  kind: "metric",
  readOnly: "enforced",
  fields: [
    {
      key: "metric",
      label: "Metric",
      type: "select",
      required: true,
      allowCustom: true,
      description:
        "Metrics that reported in the past week are listed. Type a name to use one that is not.",
    },
    {
      key: "scope",
      label: "Scope",
      type: "select",
      dependsOn: ["metric"],
      allowCustom: true,
      defaultValue: "*",
      description:
        "Which sources to include, as Datadog tags: env:prod, or several separated by commas to require all of them. * reads every source.",
    },
    {
      key: "groupBy",
      label: "Break down by",
      type: "select",
      dependsOn: ["metric"],
      allowCustom: true,
      description:
        "Optional tag key. Each value becomes its own label on the metric, and a day's total is the sum across them.",
    },
    {
      key: "spaceAggregation",
      label: "Combine sources with",
      type: "select",
      required: true,
      defaultValue: "sum",
      description: "How values reported by several hosts or containers at once are combined.",
      options: [
        { id: "sum", label: "Sum" },
        { id: "avg", label: "Average" },
        { id: "min", label: "Minimum" },
        { id: "max", label: "Maximum" },
      ],
    },
    {
      key: "valueMode",
      label: "Count metric",
      type: "select",
      defaultValue: "",
      description:
        "For count and rate metrics, read the number of events rather than the per-second rate Datadog stores.",
      options: [
        { id: "", label: "No, use the stored values" },
        { id: "count", label: "Yes, read it as a count" },
      ],
    },
    {
      key: "rollup",
      label: "Hourly rollup",
      type: "select",
      required: true,
      defaultValue: "sum",
      description:
        "How each hour is summarized before the importer combines hours into days. Sum suits counts; for averages a daily figure combines hourly values, so it is an approximation.",
      options: [
        { id: "sum", label: "Sum", description: "Right for counts." },
        { id: "avg", label: "Average" },
        { id: "min", label: "Minimum" },
        { id: "max", label: "Maximum" },
        { id: "count", label: "Number of values" },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Parameter validation: the query string is assembled here, so every
 * part is checked rather than interpolated as typed.
 * ------------------------------------------------------------------ */

/** Datadog metric names: a letter, then letters, digits, `_` and `.`, at most 200. */
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,199}$/;
/** A tag key to group by. */
const TAG_KEY = /^[A-Za-z][A-Za-z0-9_.:/-]{0,199}$/;

export interface DatadogMetricParams {
  metric: string;
  scope: string;
  groupBy: string;
  spaceAggregation: (typeof SPACE_AGGREGATIONS)[number];
  rollup: (typeof ROLLUP_METHODS)[number];
  asCount: boolean;
}

export function parseDatadogMetricParams(params: Record<string, string>): DatadogMetricParams {
  const metric = (params["metric"] ?? "").trim();
  if (!metric) throw new Error("Pick a Datadog metric.");
  if (!METRIC_NAME.test(metric)) throw new Error(`"${metric}" is not a Datadog metric name.`);

  const scope = (params["scope"] ?? "").trim() || "*";
  // The scope sits inside `{...}`, so a brace would end it early; Datadog's own
  // scope syntax (tags, commas, AND/OR/NOT, IN (...), wildcards) never needs one.
  if (/[{}\n\r]/.test(scope) || scope.length > 1000) {
    throw new Error("The scope is a list of tags such as env:prod,service:web.");
  }

  const groupBy = (params["groupBy"] ?? "").trim();
  if (groupBy && !TAG_KEY.test(groupBy)) {
    throw new Error(`"${groupBy}" is not a Datadog tag key.`);
  }

  const space = (params["spaceAggregation"] ?? "").trim() || "sum";
  if (!(SPACE_AGGREGATIONS as readonly string[]).includes(space)) {
    throw new Error(`"${space}" is not a way to combine sources.`);
  }
  const rollup = (params["rollup"] ?? "").trim() || "sum";
  if (!(ROLLUP_METHODS as readonly string[]).includes(rollup)) {
    throw new Error(`"${rollup}" is not a rollup method.`);
  }
  return {
    metric,
    scope,
    groupBy,
    spaceAggregation: space as DatadogMetricParams["spaceAggregation"],
    rollup: rollup as DatadogMetricParams["rollup"],
    asCount: (params["valueMode"] ?? "").trim() === "count",
  };
}

/** The metric query one run sends, without the rollup. */
export function datadogMetricQuery(p: DatadogMetricParams): string {
  const groups = p.groupBy ? ` by {${p.groupBy}}` : "";
  return `${p.spaceAggregation}:${p.metric}{${p.scope}}${groups}${p.asCount ? ".as_count()" : ""}`;
}

/* ------------------------------------------------------------------ *
 * Pickers.
 * ------------------------------------------------------------------ */

async function metricTags(ctx: DatadogContext, metric: string): Promise<string[]> {
  const res = await ddFetch<{ data?: { attributes?: { tags?: string[] } } }>(
    ctx,
    `/api/v2/metrics/${encodeURIComponent(metric)}/all-tags`,
    { query: { "window[seconds]": TAG_WINDOW_S } },
  );
  return res.data?.attributes?.tags ?? [];
}

/** Choices for one field of {@link DATADOG_BUSINESS_METRIC_SOURCE}. */
export async function listDatadogMetricSourceOptions(
  ctx: DatadogContext,
  fieldKey: string,
  params: Record<string, string>,
  now: number = Date.now(),
): Promise<BusinessMetricSourceOption[]> {
  switch (fieldKey) {
    case "metric": {
      const res = await ddFetch<{ metrics?: string[] }>(ctx, "/api/v1/metrics", {
        query: { from: Math.floor(now / 1000) - METRIC_LIST_LOOKBACK_S },
      });
      return [...new Set(res.metrics ?? [])]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_OPTIONS)
        .map((m) => ({ id: m, label: m }));
    }
    case "scope": {
      const metric = (params["metric"] ?? "").trim();
      const all: BusinessMetricSourceOption = {
        id: "*",
        label: "Every source",
        description: "No tag filter",
      };
      if (!METRIC_NAME.test(metric)) return [all];
      const tags = await metricTags(ctx, metric);
      return [
        all,
        ...[...new Set(tags)]
          .sort((a, b) => a.localeCompare(b))
          .slice(0, MAX_OPTIONS)
          .map((t) => ({ id: t, label: t })),
      ];
    }
    case "groupBy": {
      const metric = (params["metric"] ?? "").trim();
      const none: BusinessMetricSourceOption = {
        id: "",
        label: "No breakdown",
        description: "One value per day",
      };
      if (!METRIC_NAME.test(metric)) return [none];
      const tags = await metricTags(ctx, metric);
      const keys = new Map<string, number>();
      for (const tag of tags) {
        const key = tag.includes(":") ? tag.slice(0, tag.indexOf(":")) : tag;
        if (key) keys.set(key, (keys.get(key) ?? 0) + 1);
      }
      return [
        none,
        ...[...keys.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, MAX_OPTIONS)
          .map(([key, n]) => ({
            id: key,
            label: key,
            description: `${n} value${n === 1 ? "" : "s"}`,
          })),
      ];
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */

interface DdTimeseriesResponse {
  data?: {
    attributes?: {
      series?: Array<{ group_tags?: string[] | null; query_index?: number }>;
      times?: number[];
      values?: Array<Array<number | null>>;
    };
  };
  errors?: string;
}

/**
 * Bucket width that never straddles a local midnight: an hour, unless one of
 * the window's day boundaries falls off the hour (India's +5:30, Nepal's
 * +5:45), where it drops to fifteen minutes.
 */
export function rollupSecondsFor(from: string, to: string, timezone: string): number {
  for (let day = from; day <= nextBusinessMetricDay(to); day = nextBusinessMetricDay(day)) {
    if (zonedDayStartMs(day, timezone) % 3_600_000 !== 0) return 900;
  }
  return 3600;
}

/** `group_tags` → a label: tag values without their keys, in Datadog's order. */
function labelOf(groupTags: string[] | null | undefined): string | undefined {
  if (!groupTags || groupTags.length === 0) return undefined;
  const label = groupTags
    .map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t))
    .join(", ")
    .slice(0, BUSINESS_METRIC_SOURCE_LIMITS.maxLabelLength);
  return label || undefined;
}

/** Read the configured series over `range`, one point per rollup bucket. */
export async function runDatadogMetricSource(
  ctx: DatadogContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
  now: number = Date.now(),
): Promise<BusinessMetricSourceResult> {
  const p = parseDatadogMetricParams(params);
  if (!isBusinessMetricDay(range.from) || !isBusinessMetricDay(range.to) || range.to < range.from) {
    throw new Error("The import window must be two YYYY-MM-DD days, oldest first.");
  }
  if (!isValidTimezone(range.timezone)) {
    throw new Error(`Unknown timezone "${range.timezone}".`);
  }

  const startMs = zonedDayStartMs(range.from, range.timezone);
  const endMs = Math.min(zonedDayStartMs(nextBusinessMetricDay(range.to), range.timezone), now);
  const maxRows = Math.min(range.maxRows, BUSINESS_METRIC_SOURCE_LIMITS.maxRows);
  const intervalS = rollupSecondsFor(range.from, range.to, range.timezone);
  const intervalMs = intervalS * 1000;
  const chunkMs = DD_MAX_POINTS_PER_SERIES * intervalMs;
  const query = `${datadogMetricQuery(p)}.rollup(${p.rollup}, ${intervalS})`;

  const work = async (): Promise<BusinessMetricSourceResult> => {
    const points: BusinessMetricSourcePoint[] = [];
    let calls = 0;
    const labels = new Set<string>();
    for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkMs) {
      if (range.signal?.aborted) throw new Error("The run was cancelled.");
      const chunkEnd = Math.min(chunkStart + chunkMs, endMs);
      const res = await ddFetch<DdTimeseriesResponse>(ctx, "/api/v2/query/timeseries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            type: "timeseries_request",
            attributes: {
              from: chunkStart,
              to: chunkEnd,
              interval: intervalMs,
              queries: [{ data_source: "metrics", name: "a", query }],
            },
          },
        }),
      });
      calls++;
      if (res.errors) throw new Error(`Datadog rejected the query: ${res.errors}`);
      const attrs = res.data?.attributes ?? {};
      const times = (attrs.times ?? []).map((t) => (t < 1e12 ? t * 1000 : t));
      // A wider bucket than asked for would fold hours from either side of a
      // local midnight into one point, so a widened interval fails the run.
      if (times.length >= 2 && times[1]! - times[0]! !== intervalMs) {
        throw new Error(
          `Datadog widened the rollup to ${Math.round((times[1]! - times[0]!) / 1000)}s. Import a shorter window.`,
        );
      }
      const series = attrs.series ?? [];
      const values = attrs.values ?? [];
      series.forEach((s, i) => {
        const row = values[i] ?? [];
        const label = labelOf(s.group_tags);
        if (label) labels.add(label);
        times.forEach((ts, j) => {
          const value = row[j];
          if (typeof value !== "number" || !Number.isFinite(value)) return;
          // Datadog aligns the first bucket to UNIX time; keep only the window.
          if (ts < startMs || ts >= endMs) return;
          points.push({ date: localDayOf(ts, range.timezone), value, ...(label ? { label } : {}) });
          if (points.length > maxRows) {
            throw new Error(
              `Datadog returned more than ${maxRows} points. Import a shorter window or a coarser breakdown.`,
            );
          }
        });
      });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    const breakdown = p.groupBy
      ? `, ${labels.size} ${p.groupBy} value${labels.size === 1 ? "" : "s"}`
      : "";
    return {
      points,
      notes: [
        `Read ${points.length} ${intervalS === 3600 ? "hourly" : "15-minute"} points of ${datadogMetricQuery(p)}${breakdown} (${calls} request${calls === 1 ? "" : "s"}).`,
      ],
    };
  };

  return withBusinessMetricTimeout(work(), range);
}

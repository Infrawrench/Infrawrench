/**
 * A PromQL series as a business-metric source (the denominator a unit cost
 * divides by): pick a metric, optionally narrow it with label matchers and
 * break it down by a label, and choose how a day is summarised. Each day's
 * value is the expression evaluated at the end of that local day over a
 * window exactly one day long, so `increase(...)` reads the day's events.
 *
 * When every day in the window is 24 hours long (no DST change), the run is
 * one `query_range` with a one-day step; otherwise each day is its own
 * instant query with that day's real length. Prometheus caps a range query
 * at 11,000 points per series, far above the host's 730-day maximum.
 *
 * Read only by construction: `/api/v1/query` and `/api/v1/query_range` cannot
 * write. Picker data comes from `/api/v1/label/__name__/values` and
 * `/api/v1/labels?match[]=<metric>`.
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
import type { PromContext } from "./api.js";
import { promFetch } from "./api.js";
import type { PromSample } from "./prom.js";
import { queryRangeRaw } from "./prom.js";

const MAX_OPTIONS = 2000;
const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODES = ["increase", "avg", "max", "min", "last"] as const;

export const PROMETHEUS_BUSINESS_METRIC_SOURCE: BusinessMetricSourceDeclaration = {
  label: "Prometheus metric",
  description:
    "Read a Prometheus series, such as requests served or orders placed, and store one value per day.",
  kind: "metric",
  readOnly: "enforced",
  fields: [
    {
      key: "metric",
      label: "Metric",
      type: "select",
      required: true,
      allowCustom: true,
      description: "Every metric name the server knows. Counters usually end in _total.",
    },
    {
      key: "matchers",
      label: "Label filter",
      type: "text",
      placeholder: 'job="api", status!~"5.."',
      description: "Optional PromQL label matchers, without the braces.",
    },
    {
      key: "groupBy",
      label: "Break down by",
      type: "select",
      dependsOn: ["metric"],
      allowCustom: true,
      description: "Optional label. Each value becomes its own label on the metric.",
    },
    {
      key: "mode",
      label: "Each day is",
      type: "select",
      required: true,
      defaultValue: "increase",
      options: [
        {
          id: "increase",
          label: "The increase over the day",
          description: "Right for counters (_total).",
        },
        { id: "avg", label: "The average over the day", description: "For gauges." },
        { id: "max", label: "The maximum over the day" },
        { id: "min", label: "The minimum over the day" },
        { id: "last", label: "The last value of the day" },
      ],
    },
  ],
};

export interface PromMetricParams {
  metric: string;
  matchers: string;
  groupBy: string;
  mode: (typeof MODES)[number];
}

export function parsePromMetricParams(params: Record<string, string>): PromMetricParams {
  const metric = (params["metric"] ?? "").trim();
  if (!metric) throw new Error("Pick a Prometheus metric.");
  if (!METRIC_NAME.test(metric)) throw new Error(`"${metric}" is not a Prometheus metric name.`);
  const matchers = (params["matchers"] ?? "").trim().replace(/^\{|\}$/g, "");
  // The filter sits inside `{...}`: a brace or newline would end it and let
  // arbitrary PromQL in. Matchers themselves never need one.
  if (/[{}\n\r]/.test(matchers) || matchers.length > 1000) {
    throw new Error('The label filter is a list of matchers such as job="api".');
  }
  const groupBy = (params["groupBy"] ?? "").trim();
  if (groupBy && !LABEL_NAME.test(groupBy)) throw new Error(`"${groupBy}" is not a label name.`);
  const mode = ((params["mode"] ?? "").trim() || "increase") as PromMetricParams["mode"];
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`"${mode}" is not a summary.`);
  return { metric, matchers, groupBy, mode };
}

/** The PromQL one day's value is read with, for a window of `seconds`. */
export function promMetricQuery(p: PromMetricParams, seconds: number): string {
  const selector = `${p.metric}${p.matchers ? `{${p.matchers}}` : ""}[${seconds}s]`;
  const fn =
    p.mode === "increase"
      ? "increase"
      : p.mode === "last"
        ? "last_over_time"
        : `${p.mode}_over_time`;
  const by = p.groupBy ? ` by (${p.groupBy})` : "";
  return `sum${by} (${fn}(${selector}))`;
}

export async function listPromMetricSourceOptions(
  ctx: PromContext,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  if (fieldKey === "metric") {
    const names = await promFetch<string[]>(ctx, "/api/v1/label/__name__/values");
    return [...new Set(names ?? [])]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_OPTIONS)
      .map((n) => ({ id: n, label: n }));
  }
  if (fieldKey === "groupBy") {
    const none: BusinessMetricSourceOption = {
      id: "",
      label: "No breakdown",
      description: "One value per day",
    };
    const metric = (params["metric"] ?? "").trim();
    if (!METRIC_NAME.test(metric)) return [none];
    const labels = await promFetch<string[]>(ctx, "/api/v1/labels", {
      query: { "match[]": [metric] },
    });
    return [
      none,
      ...(labels ?? [])
        .filter((l) => l !== "__name__")
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_OPTIONS)
        .map((l) => ({ id: l, label: l })),
    ];
  }
  return [];
}

function labelOf(metric: Record<string, string> | undefined, groupBy: string): string | undefined {
  if (!groupBy) return undefined;
  const v = metric?.[groupBy];
  return v ? v.slice(0, BUSINESS_METRIC_SOURCE_LIMITS.maxLabelLength) : "(none)";
}

export async function runPromMetricSource(
  ctx: PromContext,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
  now: number = Date.now(),
): Promise<BusinessMetricSourceResult> {
  const p = parsePromMetricParams(params);
  if (!isBusinessMetricDay(range.from) || !isBusinessMetricDay(range.to) || range.to < range.from) {
    throw new Error("The import window must be two YYYY-MM-DD days, oldest first.");
  }
  if (!isValidTimezone(range.timezone)) throw new Error(`Unknown timezone "${range.timezone}".`);
  const maxRows = Math.min(range.maxRows, BUSINESS_METRIC_SOURCE_LIMITS.maxRows);

  // Day boundaries [start, end) in the importer's timezone; today is cut at now.
  const days: Array<{ day: string; startMs: number; endMs: number }> = [];
  for (let d = range.from; d <= range.to; d = nextBusinessMetricDay(d)) {
    const startMs = zonedDayStartMs(d, range.timezone);
    if (startMs >= now) break;
    days.push({
      day: d,
      startMs,
      endMs: Math.min(zonedDayStartMs(nextBusinessMetricDay(d), range.timezone), now),
    });
  }

  const work = async (): Promise<BusinessMetricSourceResult> => {
    const points: BusinessMetricSourcePoint[] = [];
    const push = (day: string, sample: PromSample, value: string | undefined) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      const label = labelOf(sample.metric, p.groupBy);
      points.push({ date: day, value: v, ...(label ? { label } : {}) });
      if (points.length > maxRows) {
        throw new Error(
          `Prometheus returned more than ${maxRows} points. Import a shorter window or drop the breakdown.`,
        );
      }
    };
    const whole = days.filter((d) => d.endMs - d.startMs === 86_400_000);
    let calls = 0;
    if (whole.length === days.length && days.length > 1) {
      const first = days[0]!;
      const last = days[days.length - 1]!;
      // Every point closes one day: evaluate at each day's end over the day before it.
      const result = await queryRangeRaw(
        ctx,
        promMetricQuery(p, 86_400),
        first.endMs / 1000,
        last.endMs / 1000,
        86_400,
      );
      calls++;
      for (const s of result) {
        for (const [t, v] of s.values ?? []) push(localDayOf(t * 1000 - 1, range.timezone), s, v);
      }
    } else {
      for (const d of days) {
        if (range.signal?.aborted) throw new Error("The run was cancelled.");
        const seconds = Math.max(1, Math.round((d.endMs - d.startMs) / 1000));
        const data = await promFetch<{ result?: PromSample[] }>(ctx, "/api/v1/query", {
          method: "POST",
          form: true,
          query: { query: promMetricQuery(p, seconds), time: d.endMs / 1000 },
        });
        calls++;
        for (const s of data?.result ?? []) push(d.day, s, s.value?.[1]);
      }
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return {
      points,
      notes: [
        `${days.length} day${days.length === 1 ? "" : "s"} in ${calls} quer${calls === 1 ? "y" : "ies"}`,
      ],
    };
  };
  return withBusinessMetricTimeout(work(), range);
}

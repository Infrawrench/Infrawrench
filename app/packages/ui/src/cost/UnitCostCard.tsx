import { useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useChartTheme } from "../chart-theme.js";
import { niceAxis } from "../components/charts/nice-axis.js";
import { formatBucketLabel, formatMoney } from "./transform.js";
import {
  describeUnitCostCaveats,
  formatUnitCostValue,
  isPartialUnitCostPoint,
  unitCostQueryForConfig,
  unitCostSeriesLabel,
  unitCostUnitLabel,
  UNIT_COST_GAP_REASON_LABELS,
  type CostGraphConfig,
  type UnitCostQueryResponse,
  type UnitCostSeries,
} from "./config.js";
import type { CostApi } from "./types.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

/**
 * The unit-cost half of {@link CostGraphCard}: spend divided by a business
 * metric (cost per unit, margin), spend divided by provider usage (cost per
 * usage unit), or the metric itself plotted beside spend (raw metric).
 *
 * A separate component from the spend card rather than a branch inside it, for
 * two reasons. The obvious one is that switching a stored config between the
 * two changes which hooks run, and React needs a remount for that: different
 * component types give it one for free. The real one is that almost nothing is
 * shared: there are no spend groups to stack, no top-N to fold, no forecast,
 * and the y axis is a ratio rather than money. What *is* shared (the bucket
 * labels, the money formatting, the axis maths) comes from the same helpers the
 * spend card uses, so a bar on one lands on the same tick as a point on the
 * other.
 *
 * **Gaps are the whole point of this component.** A bucket with nothing to
 * divide by arrives as `value: null`, is fed to recharts as `null`, and is
 * drawn with `connectNulls={false}` so the line genuinely breaks. Nothing here
 * ever coerces a gap to 0: a chart that quietly read 0 on unreported days
 * would be believed, and it says the opposite of the truth.
 */
export interface UnitCostCardProps {
  title: string;
  config: CostGraphConfig;
  api: CostApi;
  onEdit?: (() => void) | undefined;
  editLabel?: string | undefined;
  onRemove?: (() => void) | undefined;
}

/** One recharts row: `s{i}` per series (null for a gap, never 0), `c{i}` spend. */
type ChartRow = { bucket: string } & Record<string, number | null | string>;

/** At most this many series are drawn; the rest stay in the headline count. */
const MAX_DRAWN_SERIES = 10;

export function UnitCostCard({
  title,
  config,
  api,
  onEdit,
  editLabel,
  onRemove,
}: UnitCostCardProps) {
  const gt = useGT();
  const gtData = useDataString();
  const chart = useChartTheme();
  const resolvedEditLabel = editLabel ?? gt("Edit widget");
  const [response, setResponse] = useState<UnitCostQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const usageMode = config.unitCostMode === "usage_unit_cost";
  const metricId = config.unitCostMetricId ?? "";
  const request = useMemo(() => unitCostQueryForConfig(config), [config]);
  const runMetric = api.queryUnitCosts;
  const runUsage = api.queryUsageUnitCosts;

  useEffect(() => {
    const run = usageMode
      ? runUsage && config.unitCostUsageUnit
        ? () => runUsage(request)
        : null
      : runMetric && metricId
        ? () => runMetric(metricId, request)
        : null;
    if (!run) {
      setLoading(false);
      setError(
        usageMode && !config.unitCostUsageUnit
          ? gt("Choose a usage unit for this card.")
          : gt(
              "This card needs a business metric, and this app build can't query one. Open it on the web app.",
            ),
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    run()
      .then((next) => {
        if (!cancelled) setResponse(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : gt("Failed to load unit costs"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runMetric, runUsage, usageMode, metricId, request, config.unitCostUsageUnit, gt]);

  const mode = response?.mode ?? config.unitCostMode ?? "unit_cost";
  const scale = response?.scale ?? 1;
  const caveat = response ? describeUnitCostCaveats(response) : null;
  const denominatorName = response
    ? (response.metric?.name ?? response.usageUnit ?? gt("usage"))
    : "";
  const unitFor = (currency: string) =>
    unitCostUnitLabel(response?.metric ?? null, mode, currency, scale, response?.usageUnit);

  /**
   * One series per currency is the common case; more than one means spend in
   * a currency with no rate (not comparable, and the caveat says so) or a
   * label split. The chart draws each, up to a cap, rather than silently
   * picking the biggest.
   */
  const series = response?.series ?? [];
  const drawn = series.slice(0, MAX_DRAWN_SERIES);
  const grouped = Boolean(response?.groupByLabel);

  // Headline: the period value, per currency when ungrouped. A grouped card's
  // headline is the number of series, since twenty-five ratios in a row are
  // not a headline.
  const headline = grouped
    ? gt("{count} values of {label}", { count: series.length, label: response?.groupByLabel ?? "" })
    : series
        .flatMap((s) => {
          const value = formatUnitCostValue(s.overallValue, mode);
          if (value === "—") return [];
          const margin =
            mode === "margin" &&
            s.overallAbsoluteMargin !== undefined &&
            s.overallAbsoluteMargin !== null
              ? ` (${formatMoney(s.overallAbsoluteMargin, s.currency)})`
              : "";
          return [`${value}${margin}`];
        })
        .join(" · ");

  const unitLabels = [...new Set(series.map((s) => unitFor(s.currency)))];

  const hasChartData = !loading && !error && series.some((s) => s.points.length > 0);
  // Raw mode draws spend beside the metric on a second axis; once per series
  // when each label carries its own spend, once in total when they share it.
  const showSpend = mode === "raw_metric";
  const spendSeries: UnitCostSeries[] = showSpend
    ? response?.costPerLabel === false
      ? drawn.slice(0, 1)
      : drawn
    : [];

  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };

  const seriesName = (s: UnitCostSeries) =>
    s.label ? unitCostSeriesLabel(s) : series.length > 1 ? s.currency : unitFor(s.currency);

  const renderChart = () => {
    if (!response) return null;
    if (series.length === 0 || series.every((s) => s.points.length === 0)) {
      return (
        <T>
          <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-on-surface-faint">
            <Var>{denominatorName}</Var> has no values in this period, so there is nothing to show.
          </div>
        </T>
      );
    }

    // One row per bucket. `null` survives all the way into recharts: that is
    // what makes the line break.
    const rowByBucket = new Map<string, ChartRow>();
    drawn.forEach((s, i) => {
      for (const p of s.points) {
        const row: ChartRow = rowByBucket.get(p.bucket) ?? { bucket: p.bucket };
        row[`s${i}`] = p.value;
        row[`c${i}`] = p.cost;
        rowByBucket.set(p.bucket, row);
      }
    });
    const rows = [...rowByBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

    const observed = drawn.flatMap((s) =>
      s.points.map((p) => p.value).filter((v): v is number => v !== null),
    );
    const yScale = niceAxis(Math.min(0, ...observed), Math.max(0, ...observed));
    const spendObserved = spendSeries.flatMap((s) => s.points.map((p) => p.cost));
    const spendScale = niceAxis(Math.min(0, ...spendObserved), Math.max(0, ...spendObserved));
    const spendCurrency = spendSeries[0]?.currency ?? "USD";

    const formatValue = (v: number | null) => formatUnitCostValue(v, mode);
    const color = (i: number) => chart.colors[i % chart.colors.length] ?? "#60a5fa";

    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => formatBucketLabel(b, config.binning)}
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            minTickGap={24}
          />
          <YAxis
            yAxisId="value"
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            tickFormatter={(v: number) => formatValue(v)}
            domain={yScale.domain}
            ticks={yScale.ticks}
            width={70}
          />
          {showSpend && (
            <YAxis
              yAxisId="spend"
              orientation="right"
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              tickFormatter={(v: number) => formatMoney(v, spendCurrency)}
              domain={spendScale.domain}
              ticks={spendScale.ticks}
              width={70}
            />
          )}
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(b) => formatBucketLabel(String(b), config.binning)}
            // The tooltip shows the arithmetic, not just the quotient: a reader
            // who can see "$1,240 ÷ 310 customers" can check the number without
            // running a second query.
            formatter={(value, name, item) => {
              const key = String(name);
              const index = Number(key.slice(1));
              const s = drawn[index];
              if (!s) return [String(value), key];
              const bucket = (item as { payload?: ChartRow } | undefined)?.payload?.bucket;
              const point = s.points.find((p) => p.bucket === bucket);
              if (key.startsWith("c")) {
                return [
                  formatMoney(typeof value === "number" ? value : 0, s.currency),
                  gt("{series} spend", { series: seriesName(s) }),
                ];
              }
              let detail = "";
              if (point && mode !== "raw_metric") {
                const denominator =
                  point.metricValue === null ? "—" : point.metricValue.toLocaleString();
                detail =
                  mode === "margin"
                    ? ` (${formatMoney(point.absoluteMargin ?? 0, s.currency)})`
                    : ` (${formatMoney(point.cost, s.currency)} ÷ ${denominator})`;
              }
              return [
                `${formatValue(typeof value === "number" ? value : null)}${detail}`,
                seriesName(s),
              ];
            }}
          />
          {drawn.map((s, i) => (
            <Line
              key={`s${i}`}
              yAxisId="value"
              type="monotone"
              dataKey={`s${i}`}
              name={`s${i}`}
              stroke={color(i)}
              strokeWidth={2}
              dot={false}
              // The single most important prop in this file. A gap must render
              // as a gap; bridging it would draw a straight line across days
              // nobody measured and make them look measured.
              connectNulls={false}
            />
          ))}
          {spendSeries.map((s, i) => (
            <Line
              key={`c${i}`}
              yAxisId="spend"
              type="monotone"
              dataKey={`c${i}`}
              name={`c${i}`}
              stroke={response.costPerLabel === false ? chart.axis : color(i)}
              strokeDasharray="4 3"
              strokeWidth={1.5}
              dot={false}
            />
          ))}
          {/* Partially reported buckets get a hollow marker: the ratio there is
              real but reads high, and a reader deserves to see which points
              those are rather than only a count under the title. */}
          {drawn.flatMap((s, i) =>
            s.points.flatMap((p) =>
              isPartialUnitCostPoint(p) && mode !== "raw_metric"
                ? [
                    <ReferenceDot
                      key={`${i}-${p.bucket}`}
                      yAxisId="value"
                      x={p.bucket}
                      y={p.value ?? 0}
                      r={4}
                      fill="none"
                      stroke={color(i)}
                      strokeWidth={2}
                    />,
                  ]
                : [],
            ),
          )}
        </LineChart>
      </ResponsiveContainer>
    );
  };

  const gapSummary = useMemo(() => {
    if (!response) return null;
    const reasons = new Set(
      response.series.flatMap((s) => s.points.flatMap((p) => (p.gap ? [p.gap] : []))),
    );
    if (reasons.size === 0) return null;
    return [...reasons].map((r) => gtData(UNIT_COST_GAP_REASON_LABELS[r])).join("; ");
  }, [response, gtData]);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden min-h-[18rem]">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={resolvedEditLabel}
            aria-label={resolvedEditLabel}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✎
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title={gt("Remove from dashboard")}
            aria-label={gt("Remove from dashboard")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      <div className="px-5 pt-4 pb-1">
        <div className="flex items-baseline gap-3 pr-14">
          <h3 className="text-base font-semibold text-on-surface leading-tight truncate">
            {title || gt("Unit costs")}
          </h3>
          {headline && (
            <span className="text-sm text-on-surface-secondary flex-shrink-0">{headline}</span>
          )}
        </div>
        {response && (
          <p className="text-[11px] text-on-surface-faint mt-0.5">
            {unitLabels.join(" · ") || gt("per unit")} · {denominatorName}
            {series.length > MAX_DRAWN_SERIES
              ? ` · ${gt("showing {shown} of {total}", { shown: MAX_DRAWN_SERIES, total: series.length })}`
              : ""}
          </p>
        )}
        {caveat && (
          <p className="text-[11px] text-warning mt-0.5" role="note">
            {caveat}
            {gapSummary ? ` (${gapSummary})` : ""}
          </p>
        )}
      </div>

      <div
        className="flex-1 min-h-0 px-3 pb-3 flex flex-col"
        role={hasChartData ? "img" : undefined}
        aria-label={
          hasChartData
            ? gt("{title} chart, {headline} {unit}{gapNote}", {
                title: title || gt("Unit costs"),
                headline: headline || gt("no period value"),
                unit: unitLabels[0] ?? "",
                gapNote:
                  response && response.gapBuckets > 0
                    ? gt(", {count} periods with no metric value", {
                        count: response.gapBuckets,
                      })
                    : "",
              })
            : undefined
        }
      >
        {loading ? (
          <div
            role="status"
            className="flex-1 flex items-center justify-center text-sm text-on-surface-faint"
          >
            {gt("Loading unit costs…")}
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex-1 flex items-center justify-center text-sm text-danger px-4 text-center"
          >
            {error}
          </div>
        ) : (
          renderChart()
        )}
      </div>
    </div>
  );
}

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
  unitCostUnitLabel,
  UNIT_COST_GAP_REASON_LABELS,
  type CostGraphConfig,
  type UnitCostQueryResponse,
} from "./config.js";
import type { CostApi } from "./types.js";

/**
 * The unit-cost half of {@link CostGraphCard}: spend divided by a business
 * metric, drawn as cost per unit (or margin) instead of cost.
 *
 * A separate component from the spend card rather than a branch inside it, for
 * two reasons. The obvious one is that switching a stored config between the
 * two changes which hooks run, and React needs a remount for that — different
 * component types give it one for free. The real one is that almost nothing is
 * shared: there are no groups to stack, no top-N to fold, no forecast, and the
 * y axis is a ratio rather than money. What *is* shared — the bucket labels,
 * the money formatting, the axis maths — comes from the same helpers the spend
 * card uses, so a bar on one lands on the same tick as a point on the other.
 *
 * **Gaps are the whole point of this component.** A bucket with no reported
 * metric value arrives as `value: null`, is fed to recharts as `null`, and is
 * drawn with `connectNulls={false}` so the line genuinely breaks. Nothing here
 * ever coerces a gap to 0 — a chart that quietly read 0 on unreported days
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

/** One recharts row. `value` is `null` for a gap, never 0. */
interface ChartRow {
  bucket: string;
  value: number | null;
}

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

  const metricId = config.unitCostMetricId ?? "";
  const request = useMemo(() => unitCostQueryForConfig(config), [config]);
  const run = api.queryUnitCosts;

  useEffect(() => {
    if (!run || !metricId) {
      setLoading(false);
      setError(
        gt(
          "This card needs a business metric, and this app build can't query one. Open it on the web app.",
        ),
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    run(metricId, request)
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
  }, [run, metricId, request, gt]);

  const mode = response?.mode ?? config.unitCostMode ?? "unit_cost";
  const caveat = response ? describeUnitCostCaveats(response) : null;

  /**
   * One series is the overwhelmingly common case; more than one means spend in
   * a currency the org holds no rate for, and those series are not comparable
   * to each other (the caveat line says so). The chart draws each one, and the
   * headline reports each one, rather than silently picking the biggest.
   */
  const series = response?.series ?? [];
  // One pass: format and drop the un-formattable in the same step. A series
  // with no period value formats to the em dash and is left out entirely —
  // printing it would put a dash in the headline next to a real ratio.
  const headline = series
    .flatMap((s) => {
      const value = formatUnitCostValue(s.overallValue, mode);
      return value === "—" ? [] : [value];
    })
    .join(" · ");

  const unitLabels = series.map((s) =>
    unitCostUnitLabel({ unit: response?.metric.unit ?? "unit" }, mode, s.currency),
  );

  const hasChartData = !loading && !error && series.some((s) => s.points.length > 0);

  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };

  const renderChart = () => {
    if (!response) return null;
    if (series.length === 0 || series.every((s) => s.points.length === 0)) {
      return (
        <T>
          <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-on-surface-faint">
            <Var>{response.metric.name}</Var> has no values in this period, so there is nothing to
            divide by.
          </div>
        </T>
      );
    }

    // One row per bucket, one column per currency series. `null` survives all
    // the way into recharts — that is what makes the line break.
    const rowByBucket = new Map<string, ChartRow & Record<string, number | null | string>>();
    series.forEach((s, i) => {
      for (const p of s.points) {
        const row = rowByBucket.get(p.bucket) ?? { bucket: p.bucket, value: null };
        row[`s${i}`] = p.value;
        rowByBucket.set(p.bucket, row);
      }
    });
    const rows = [...rowByBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

    const observed = series.flatMap((s) =>
      s.points.map((p) => p.value).filter((v): v is number => v !== null),
    );
    const yScale = niceAxis(Math.min(0, ...observed), Math.max(0, ...observed));

    const formatValue = (v: number | null) => formatUnitCostValue(v, mode);

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
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            tickFormatter={(v: number) => formatValue(v)}
            domain={yScale.domain}
            ticks={yScale.ticks}
            width={70}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(b) => formatBucketLabel(String(b), config.binning)}
            // The tooltip shows the arithmetic, not just the quotient: a reader
            // who can see "$1,240 ÷ 310 customers" can check the number without
            // running a second query, and can tell a small ratio caused by low
            // spend from one caused by high volume.
            formatter={(value, name) => {
              const index = Number(String(name).slice(1));
              const s = series[index];
              const point = s?.points.find(
                (p) => p.value === (typeof value === "number" ? value : null),
              );
              const detail =
                s && point
                  ? ` (${formatMoney(point.cost, s.currency)} ÷ ${
                      point.metricValue ?? "—"
                    } ${response.metric.unit})`
                  : "";
              return [
                `${formatValue(typeof value === "number" ? value : null)}${detail}`,
                unitLabels[index] ?? "",
              ];
            }}
          />
          {series.map((s, i) => (
            <Line
              key={s.currency}
              type="monotone"
              dataKey={`s${i}`}
              name={`s${i}`}
              stroke={chart.colors[i % chart.colors.length] ?? "#60a5fa"}
              strokeWidth={2}
              dot={false}
              // The single most important prop in this file. A gap must render
              // as a gap; bridging it would draw a straight line across days
              // nobody measured and make them look measured.
              connectNulls={false}
            />
          ))}
          {/* Partially reported buckets get a hollow marker: the ratio there is
              real but reads high, and a reader deserves to see which points
              those are rather than only a count under the title. */}
          {series.flatMap((s, i) =>
            s.points.flatMap((p) =>
              isPartialUnitCostPoint(p)
                ? [
                    <ReferenceDot
                      key={`${s.currency}-${p.bucket}`}
                      x={p.bucket}
                      y={p.value ?? 0}
                      r={4}
                      fill="none"
                      stroke={chart.colors[i % chart.colors.length] ?? "#60a5fa"}
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
    // `flatMap` over the points rather than map-then-filter: one pass, and the
    // set comes out typed as the reasons themselves, so the label lookup needs
    // no non-null assertion.
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
            ✕
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
            {unitLabels.join(" · ") || gt("per unit")} · {response.metric.name}
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

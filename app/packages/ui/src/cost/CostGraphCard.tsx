import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  FORECAST_COLOR,
  OTHER_SERIES_COLOR,
  SCENARIO_COLOR,
  type CostConversion,
} from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { niceAxis, rowsExtent } from "../components/charts/nice-axis.js";
import { CostAnnotationModal } from "./CostAnnotationModal.js";
import {
  bucketCostAnnotations,
  costQueryForConfig,
  describeCostAnnotationScope,
  describeCostConversion,
  formatCostAnnotationDates,
  type CostAnnotation,
  type CostAnnotationInput,
  type CostAnnotationMarker,
  type CostGraphConfig,
  type CostQueryResponse,
} from "./config.js";
import {
  alignComparison,
  COMPARISON_KEY,
  FORECAST_KEY,
  SCENARIO_KEY,
  formatBucketLabel,
  formatMoney,
  pivotSeries,
  spliceForecast,
  spliceScenario,
  type PivotedChart,
} from "./transform.js";
import type { CostApi } from "./types.js";
import { UnitCostCard } from "./UnitCostCard.js";

export interface CostGraphCardProps {
  title: string;
  config: CostGraphConfig;
  api: CostApi;
  /** Shown when some contributing account only has monthly-native data. */
  periodNativeNote?: boolean | undefined;
  onEdit?: (() => void) | undefined;
  /**
   * What the pencil does, for the tooltip and the accessible name. A saved
   * report's card doesn't edit anything in place — it opens the report — and a
   * button that says "Edit widget" while navigating elsewhere is a lie.
   */
  editLabel?: string | undefined;
  onRemove?: (() => void) | undefined;
  /**
   * Draw this report's annotations as well as the org-wide ones, and scope new
   * notes written from this chart to it. Absent on an ad-hoc dashboard card,
   * which has no report to belong to and therefore sees only org-wide notes.
   */
  annotationReportId?: string | undefined;
  /** The report's name, for the scope choice in the annotation editor. */
  annotationReportName?: string | undefined;
  /**
   * Called with each loaded response's `conversion` block — `undefined` when
   * nothing was converted, which is what an org that has stated no exchange
   * rates always sees.
   *
   * The card prints the one-line {@link describeCostConversion} footnote
   * itself, which is as much as a card has room for. This lets the page hosting
   * the card render the full `CostConversionNotice` above it, which is the only
   * surface that names each rate and the date it took effect. Never called by
   * the unit-cost chart: that one plots a ratio, not an amount.
   */
  onConversion?: ((conversion: CostConversion | undefined) => void) | undefined;
}

interface LoadedState {
  response: CostQueryResponse;
  pivot: PivotedChart;
}

/**
 * The spend chart — what a cost card has always drawn. Not exported: callers go
 * through {@link CostGraphCard}, which picks between this and the unit-cost
 * chart from the config.
 */
function SpendGraphCard({
  title,
  config,
  api,
  periodNativeNote,
  onEdit,
  editLabel,
  onRemove,
  annotationReportId,
  annotationReportName,
  onConversion,
}: CostGraphCardProps) {
  const gt = useGT();
  const resolvedEditLabel = editLabel ?? gt("Edit widget");
  const chart = useChartTheme();
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [annotations, setAnnotations] = useState<CostAnnotation[]>([]);
  /** Which marker's notes are expanded under the chart; null is none. */
  const [openMarker, setOpenMarker] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    annotation: CostAnnotation | null;
    startDate: string;
  } | null>(null);

  const request = useMemo(() => costQueryForConfig(config), [config]);

  /**
   * Held in a ref rather than listed in the fetch effect's dependencies: a
   * caller that passes an inline arrow — the ordinary way to write this — would
   * otherwise re-run the query on every render of the page above.
   */
  const onConversionRef = useRef(onConversion);
  onConversionRef.current = onConversion;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .queryCosts(request)
      .then((response) => {
        if (cancelled) return;
        const pivot = pivotSeries(response.series);
        if (response.comparison && config.chartType !== "pie") {
          alignComparison(pivot.rows, response.comparison);
        }
        if (response.forecast && config.chartType !== "pie") {
          spliceForecast(pivot, response, config.binning);
        }
        // A second overlay, never a replacement for the first: the trend line
        // stays on the chart beside the scenario line so a reader can see what
        // the fit said before anybody's assumptions touched it.
        if (response.scenario && config.chartType !== "pie") {
          spliceScenario(pivot, response, config.binning);
        }
        setState({ response, pivot });
        onConversionRef.current?.(response.conversion);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : gt("Failed to load costs"));
        // Withdraw the caveat with the figure it was about: a notice naming
        // rates for a chart that failed to load describes nothing on screen.
        onConversionRef.current?.(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, request, config.chartType, config.binning]);

  const loadAnnotations = api.listCostAnnotations;
  const refreshAnnotations = useCallback(async () => {
    if (!loadAnnotations) return;
    try {
      setAnnotations(await loadAnnotations(annotationReportId));
    } catch {
      // The chart is the point of this card; annotations are commentary on it.
      // A failed notes fetch degrades to a chart with no markers rather than
      // replacing a working chart with an error about something else.
      setAnnotations([]);
    }
  }, [loadAnnotations, annotationReportId]);

  useEffect(() => {
    void refreshAnnotations();
  }, [refreshAnnotations]);

  /**
   * The markers, derived from the buckets the chart actually drew.
   *
   * `pivot.rows` is read, never written: annotations are an overlay, so the
   * series, the totals and the y domain are computed from exactly the same rows
   * whether or not a single note exists.
   */
  const markers: CostAnnotationMarker[] = useMemo(() => {
    if (!state || config.chartType === "pie") return [];
    return bucketCostAnnotations(
      annotations,
      state.pivot.rows.map((r) => String(r["bucket"])),
      config.binning,
    );
  }, [annotations, state, config.binning, config.chartType]);

  const canWriteAnnotations = Boolean(
    api.createCostAnnotation && api.updateCostAnnotation && api.deleteCostAnnotation,
  );
  const openMarkerRow = markers.find((m) => m.bucket === openMarker) ?? null;

  const currency = state?.response.currencies[0] ?? "USD";
  const mixedCurrency = (state?.response.currencies.length ?? 0) > 1;
  const conversionNote = describeCostConversion(state?.response.conversion);
  /**
   * The applied scenario, and the label its line carries.
   *
   * The model's *name* is in the legend and the tooltip rather than a generic
   * "Scenario", because a projection that silently includes somebody's
   * assumptions is worse than no projection: the reader has to be able to tell
   * which assumptions, from the chart alone.
   */
  const scenario = state?.response.scenario;
  const scenarioLabel = scenario
    ? gt("Scenario: {name}", { name: scenario.modelName })
    : gt("Scenario");
  /**
   * The org's billing rules, when this card asked for them.
   *
   * Rendered unconditionally whenever the response carries it, and next to the
   * total rather than in a tooltip. That is the whole raw-vs-adjusted contract
   * on the client side: the server cannot return an adjusted figure without
   * `adjustment.rawTotals`, and this card cannot draw one without saying so and
   * printing the collected number beside it. A card someone screenshots into a
   * finance review has to carry both figures or it reconciles against nothing.
   */
  const adjustment = state?.response.adjustment;
  const adjustedRawTotal = adjustment
    ? Object.entries(adjustment.rawTotals)
        .map(([cur, amt]) => formatMoney(amt, cur))
        .join(" + ")
    : null;
  const adjustedFixedTotal =
    adjustment && Object.keys(adjustment.fixedTotals).length > 0
      ? Object.entries(adjustment.fixedTotals)
          .map(([cur, amt]) => formatMoney(amt, cur))
          .join(" + ")
      : null;
  const total = state
    ? Object.entries(state.response.totals)
        .map(([cur, amt]) => formatMoney(amt, cur))
        .join(" + ")
    : null;
  const previousTotal =
    state?.response.previousTotals &&
    Object.entries(state.response.previousTotals)
      .map(([cur, amt]) => formatMoney(amt, cur))
      .join(" + ");

  const deltaPct = useMemo(() => {
    if (!state?.response.previousTotals) return null;
    const cur = state.response.totals[currency] ?? 0;
    const prev = state.response.previousTotals[currency] ?? 0;
    if (prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  }, [state, currency]);

  const chartAriaLabel = useMemo(() => {
    const parts = [gt("{title} chart", { title: title || gt("Costs") })];
    if (total) parts.push(gt("total {total}", { total }));
    if (deltaPct !== null) {
      parts.push(
        deltaPct > 0
          ? gt("up {percent}% vs previous period", { percent: Math.abs(deltaPct).toFixed(1) })
          : gt("down {percent}% vs previous period", { percent: Math.abs(deltaPct).toFixed(1) }),
      );
    }
    // The chart body is one opaque image to assistive tech, so the count has to
    // be said here; the notes themselves are read from the rail below it.
    const noted = markers.reduce((sum, m) => sum + m.annotations.length, 0);
    if (noted > 0) {
      parts.push(
        noted === 1
          ? gt("{count} annotation", { count: noted })
          : gt("{count} annotations", { count: noted }),
      );
    }
    // Said here as well as in the header: the chart body is one opaque image to
    // assistive tech, so "part of this line is an assumption" cannot be left to
    // a legend nobody can read.
    if (scenario) {
      parts.push(gt("projection includes scenario {name}", { name: scenario.modelName }));
    }
    return parts.join(", ");
  }, [title, total, deltaPct, markers, scenario]);

  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };

  /**
   * Categorical series colors — the app-wide chart theme order, assigned in
   * fixed order by series rank-at-load (API returns groups ranked with "Other"
   * last). "Other" always renders in neutral gray, never a categorical hue.
   *
   * The overlay lines below do *not* come through here. They use the named
   * `FORECAST_COLOR` / `SCENARIO_COLOR` from the shared palette, because a slot
   * in this rotation means "the fourth series", not "amber".
   */
  const colorFor = (index: number, isOther: boolean): string =>
    isOther
      ? OTHER_SERIES_COLOR
      : (chart.colors[index % chart.colors.length] ?? OTHER_SERIES_COLOR);

  // The chart body is exposed as a single role="img" with a summary label
  // only when a chart is actually rendered — loading, error, and empty
  // states keep their own text visible to assistive tech.
  const hasChartData = !loading && !error && (state?.pivot.rows.length ?? 0) > 0;

  const renderChart = () => {
    if (!state) return null;
    const { pivot, response } = state;

    if (pivot.rows.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-on-surface-faint">
          {gt("No cost data for this period yet")}
        </div>
      );
    }

    if (config.chartType === "pie") {
      const slices = response.series.map((s, i) => ({
        name: s.label,
        value: s.points.reduce((sum, p) => sum + p.amount, 0),
        fill: colorFor(i, s.key === "__other__"),
      }));
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="45%"
              outerRadius="80%"
              paddingAngle={2}
              stroke="none"
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value, name) => [formatMoney(Number(value), currency), String(name)]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => <span style={{ color: chart.tick }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      );
    }

    const isBar = config.chartType === "stacked_bar" || config.chartType === "multi_bar";
    const stacked = config.chartType === "stacked_bar" || config.chartType === "area";

    // Own the y scale rather than leaving it to recharts, which stretches the
    // domain below zero to hit its tick count (a US$2.65 max axis starting at
    // -US$0.90). Ticks follow from a nice step over the plotted values.
    const seriesKeys = pivot.series.map((s) => s.dataKey);
    const overlayKeys = [
      ...(response.comparison ? [COMPARISON_KEY] : []),
      ...(response.forecast ? [FORECAST_KEY] : []),
      ...(response.scenario ? [SCENARIO_KEY] : []),
    ];
    const extent = rowsExtent(pivot.rows, {
      stackedKeys: stacked ? seriesKeys : [],
      keys: stacked ? overlayKeys : [...seriesKeys, ...overlayKeys],
    });
    const yScale = niceAxis(extent.min, extent.max);

    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={pivot.rows}
          margin={{ top: 4, right: 4, left: 4, bottom: 0 }}
          {...(canWriteAnnotations
            ? {
                // Clicking a bar is the natural way to say "something happened
                // here". The keyboard route to the same editor is the rail
                // below the chart — this is the pointer shortcut, not the only
                // way in.
                onClick: (nextState: { activeLabel?: string | number | undefined }) => {
                  const bucket = nextState?.activeLabel;
                  if (typeof bucket !== "string") return;
                  const existing = markers.find((m) => m.bucket === bucket);
                  if (existing) setOpenMarker(bucket);
                  else setEditing({ annotation: null, startDate: bucket });
                },
              }
            : {})}
        >
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
            tickFormatter={(v: number) => formatMoney(v, currency)}
            domain={yScale.domain}
            ticks={yScale.ticks}
            width={70}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(b) => formatBucketLabel(String(b), config.binning)}
            formatter={(value, name) => {
              const label =
                String(name) === COMPARISON_KEY
                  ? gt("Previous period")
                  : String(name) === FORECAST_KEY
                    ? gt("Forecast (trend)")
                    : String(name) === SCENARIO_KEY
                      ? scenarioLabel
                      : (pivot.series.find((s) => s.dataKey === String(name))?.label ??
                        String(name));
              return [formatMoney(Number(value), currency), label];
            }}
          />
          {pivot.series.length > 1 && (
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => {
                const def = pivot.series.find((s) => s.dataKey === value);
                return (
                  <span style={{ color: chart.tick }}>
                    {def?.label ??
                      (value === COMPARISON_KEY
                        ? gt("Previous period")
                        : value === FORECAST_KEY
                          ? gt("Forecast (trend)")
                          : value === SCENARIO_KEY
                            ? scenarioLabel
                            : value)}
                  </span>
                );
              }}
            />
          )}
          {pivot.series.map((def, i) =>
            isBar ? (
              <Bar
                key={def.dataKey}
                dataKey={def.dataKey}
                name={def.dataKey}
                {...(stacked ? { stackId: "a" } : {})}
                fill={colorFor(i, def.isOther)}
                radius={stacked ? 0 : [3, 3, 0, 0]}
                maxBarSize={40}
              />
            ) : config.chartType === "area" ? (
              <Area
                key={def.dataKey}
                type="monotone"
                dataKey={def.dataKey}
                name={def.dataKey}
                stackId="a"
                stroke={colorFor(i, def.isOther)}
                fill={colorFor(i, def.isOther)}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ) : (
              <Line
                key={def.dataKey}
                type="monotone"
                dataKey={def.dataKey}
                name={def.dataKey}
                stroke={colorFor(i, def.isOther)}
                strokeWidth={2}
                dot={false}
              />
            ),
          )}
          {response.comparison && (
            <Line
              type="monotone"
              dataKey={COMPARISON_KEY}
              name={COMPARISON_KEY}
              stroke={chart.tick}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
            />
          )}
          {response.forecast && (
            <Line
              type="monotone"
              dataKey={FORECAST_KEY}
              name={FORECAST_KEY}
              stroke={FORECAST_COLOR}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              connectNulls={false}
            />
          )}
          {/*
            The scenario overlay. Drawn *after* the trend line and in a
            different hue, because the two are different claims: one is what the
            data extrapolates to, the other is what somebody says they know.
          */}
          {response.scenario && (
            <Line
              type="monotone"
              dataKey={SCENARIO_KEY}
              name={SCENARIO_KEY}
              stroke={SCENARIO_COLOR}
              strokeWidth={2}
              strokeDasharray="2 3"
              dot={false}
              connectNulls={false}
            />
          )}
          {/*
            Annotation markers, in the idiom the comparison and forecast
            overlays already use: recharts primitives that reference existing
            categories and carry no data of their own. Every `x` here is a
            bucket the chart drew (bucketCostAnnotations guarantees it), so the
            axis domain and the plotted values are exactly what they would be
            with no annotations at all — `ifOverflow="hidden"` keeps that true
            even if a bucket ever went missing between the two renders.
          */}
          {markers.map((marker) => (
            <Fragment key={marker.bucket}>
              {marker.endBucket && (
                <ReferenceArea
                  x1={marker.bucket}
                  x2={marker.endBucket}
                  ifOverflow="hidden"
                  fill={chart.tick}
                  fillOpacity={0.08}
                  stroke="none"
                />
              )}
              <ReferenceLine
                x={marker.bucket}
                ifOverflow="hidden"
                stroke={chart.tick}
                strokeWidth={1}
                strokeDasharray="2 3"
                label={{
                  value: String(marker.index),
                  position: "top",
                  fill: chart.tick,
                  fontSize: 10,
                }}
              />
            </Fragment>
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    );
  };

  return (
    // The double-width span lives on the dashboard's sortable wrapper (the
    // grid item); this card only owns its own minimum height.
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
            {title || gt("Costs")}
          </h3>
          {/*
            A ternary rather than `total && …`: this slot sits next to money, so
            a falsy left-hand side that React can render — a `0`, an empty
            string — would print beside the title and read as a real figure.
            `total` is the joined per-currency string and is `""` for a response
            with no totals at all, which must draw nothing rather than an empty
            amount.
          */}
          {total ? (
            <span className="text-sm text-on-surface-secondary flex-shrink-0">{total}</span>
          ) : null}
          {adjustment && (
            <span
              className="text-[10px] uppercase tracking-wide text-warning border border-amber-500/40 rounded px-1 py-px flex-shrink-0"
              title={gt("The organisation's billing rules are applied to this figure.")}
            >
              {gt("Adjusted")}
            </span>
          )}
          {deltaPct !== null && (
            <span
              className={`text-xs flex-shrink-0 ${deltaPct > 0 ? "text-danger" : "text-success"}`}
              title={
                previousTotal ? gt("Previous period: {total}", { total: previousTotal }) : undefined
              }
            >
              {deltaPct > 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
            </span>
          )}
        </div>
        {/*
          Applying a scenario is stated in the card's own header, not left to
          the legend. A card someone screenshots into a planning doc has to
          carry the fact that part of its line is an assumption, whose
          assumption it is, and how much of the projection it accounts for.
        */}
        {adjustment && (
          <p className="text-[11px] text-warning mt-0.5">
            {gt("Billing rules applied — collected spend {total}.", { total: adjustedRawTotal })}
            {adjustment.rules.length > 0
              ? gt(" In force: {rules}.", {
                  rules: adjustment.rules.map((r) => `${r.name} (${r.summary})`).join("; "),
                })
              : gt(" No billing rules are defined, so these are the collected figures.")}
            {/*
              Fixed charges are stated separately and never folded into the
              total above, which stays the sum of the series drawn. The figure
              the org reports internally is the two added together, and saying
              that out loud is cheaper than a total nobody can add up from the
              bars.
            */}
            {adjustedFixedTotal &&
              gt(
                " Plus {amount} in fixed charges, not included in the total above (they have no series behind them).",
                { amount: adjustedFixedTotal },
              )}
          </p>
        )}
        {scenario && (
          <p className="text-[11px] text-warning mt-0.5">
            {gt(
              'Projection includes scenario "{name}" ({sign}{amount} over the forecast horizon). The dashed trend line is the unadjusted forecast.',
              {
                name: scenario.modelName,
                sign: scenario.totalDelta >= 0 ? "+" : "−",
                amount: formatMoney(Math.abs(scenario.totalDelta), scenario.currency),
              },
            )}
            {scenario.convertedFrom &&
              gt(" Amounts converted from {currency} at your stated rates.", {
                currency: scenario.convertedFrom,
              })}
            {scenario.outOfScope.length > 0 &&
              gt(" Not applied here (out of this chart's scope): {list}.", {
                list: scenario.outOfScope.join(", "),
              })}
          </p>
        )}
        {(mixedCurrency || periodNativeNote || conversionNote) && (
          <p className="text-[11px] text-on-surface-faint mt-0.5">
            {mixedCurrency && gt("Mixed currencies — series are shown per currency. ")}
            {/*
              Sits with the other caveats, under the title, for the same reason
              they do: a total that folded three currencies together at rates
              somebody set months ago has to say so next to the number, not in
              a tooltip nobody opens.
            */}
            {conversionNote && `${conversionNote} `}
            {periodNativeNote && gt("Some providers report monthly totals, shown on period dates.")}
          </p>
        )}
      </div>

      <div
        className="flex-1 min-h-0 px-3 pb-3 flex flex-col"
        role={hasChartData ? "img" : undefined}
        aria-label={hasChartData ? chartAriaLabel : undefined}
      >
        {loading ? (
          <div
            role="status"
            className="flex-1 flex items-center justify-center text-sm text-on-surface-faint"
          >
            {gt("Loading costs…")}
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

      {/*
        The annotation rail — deliberately outside the `role="img"` chart body,
        which would hide these controls from assistive tech, and deliberately
        not a hover affordance. The numbered flags on the chart are the visual
        marker; this is how they are read and reached with a keyboard, on a
        phone, and by anyone who never hovers anything.
      */}
      {(markers.length > 0 || (canWriteAnnotations && hasChartData)) && (
        <div className="px-4 pb-3 -mt-1 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1">
            {markers.map((marker) => {
              const first = marker.annotations[0]!;
              const more = marker.annotations.length - 1;
              const dates = formatCostAnnotationDates(first);
              return (
                <button
                  key={marker.bucket}
                  type="button"
                  onClick={() => setOpenMarker(openMarker === marker.bucket ? null : marker.bucket)}
                  aria-expanded={openMarker === marker.bucket}
                  aria-label={
                    more > 0
                      ? gt(
                          "Annotation {index}, {dates}: {text}, and {more} more on the same bucket",
                          {
                            index: marker.index,
                            dates,
                            text: first.text,
                            more,
                          },
                        )
                      : gt("Annotation {index}, {dates}: {text}", {
                          index: marker.index,
                          dates,
                          text: first.text,
                        })
                  }
                  className="flex max-w-full items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-on-surface-secondary hover:border-border-strong hover:text-on-surface focus-visible:border-border-strong"
                >
                  <span
                    aria-hidden
                    className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[9px] text-on-surface-faint"
                  >
                    {marker.index}
                  </span>
                  <span aria-hidden className="shrink-0 text-on-surface-faint">
                    {dates}
                  </span>
                  <span aria-hidden className="truncate">
                    {first.text}
                  </span>
                  {more > 0 && (
                    <span aria-hidden className="shrink-0 text-on-surface-faint">
                      +{more}
                    </span>
                  )}
                </button>
              );
            })}
            {canWriteAnnotations && hasChartData && (
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    annotation: null,
                    // Default to the chart's last bucket — the thing somebody
                    // is usually explaining is the most recent movement.
                    startDate: String(
                      state?.pivot.rows[state.pivot.rows.length - 1]?.["bucket"] ??
                        new Date().toISOString().slice(0, 10),
                    ),
                  })
                }
                className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-on-surface-faint hover:border-border-strong hover:text-on-surface-secondary"
              >
                {gt("+ Annotate")}
              </button>
            )}
          </div>

          {openMarkerRow && (
            <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken px-2.5 py-2">
              {openMarkerRow.annotations.map((annotation) => (
                <li key={annotation.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-on-surface">{annotation.text}</p>
                    <p className="text-[11px] text-on-surface-faint">
                      {formatCostAnnotationDates(annotation)} ·{" "}
                      {describeCostAnnotationScope(annotation)}
                      {/*
                        Provenance, said where the note is read: this sentence
                        was written to close a detected anomaly, so a reader who
                        doubts it can go and check it against the finding rather
                        than taking it on trust.
                      */}
                      {annotation.costAnomalyId ? gt(" · Explains a detected anomaly") : ""}
                    </p>
                  </div>
                  {canWriteAnnotations && (
                    <button
                      type="button"
                      onClick={() => setEditing({ annotation, startDate: annotation.startDate })}
                      className="shrink-0 text-[11px] text-on-surface-faint underline hover:text-on-surface-secondary"
                    >
                      {gt("Edit")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing && (
        <CostAnnotationModal
          annotation={editing.annotation}
          defaultStartDate={editing.startDate}
          {...(annotationReportId ? { reportId: annotationReportId } : {})}
          {...(annotationReportName ? { reportName: annotationReportName } : {})}
          onSave={async (input: CostAnnotationInput) => {
            if (editing.annotation) await api.updateCostAnnotation!(editing.annotation.id, input);
            else await api.createCostAnnotation!(input);
            await refreshAnnotations();
          }}
          {...(editing.annotation
            ? {
                onDelete: async () => {
                  await api.deleteCostAnnotation!(editing.annotation!.id);
                  setOpenMarker(null);
                  await refreshAnnotations();
                },
              }
            : {})}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * A cost card: spend over time, or — when the config names a business metric —
 * cost per unit of it.
 *
 * The switch lives here, at the component boundary, rather than as a branch
 * inside either chart. Two different component types is what lets React remount
 * cleanly when a stored config is edited from one mode into the other, and it
 * keeps each chart free of the other's concepts: the spend chart knows nothing
 * about gaps in a denominator, and the unit-cost chart knows nothing about
 * stacking, top-N or forecasts.
 *
 * `unitCostMetricId` is absent on every config written before unit costs
 * existed, so an old card draws exactly what it always drew.
 */
export function CostGraphCard(props: CostGraphCardProps) {
  if (props.config.unitCostMetricId) {
    return (
      <UnitCostCard
        title={props.title}
        config={props.config}
        api={props.api}
        onEdit={props.onEdit}
        editLabel={props.editLabel}
        onRemove={props.onRemove}
      />
    );
  }
  return <SpendGraphCard {...props} />;
}

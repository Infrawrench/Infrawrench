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
  applyCostDrillPath,
  costComparisonDelta,
  costDrillChoices,
  costDrillNeedsChoice,
  costDrillReportName,
  costDrillTarget,
  costSeriesTotal,
  effectiveCostBinning,
  formatCostChangePct,
  formatCostMeasureValue,
  isCostDrillableValue,
  isCostTotalsChart,
  nextCostDrillDimension,
  resolveCostDrillStep,
  type CostConversion,
  type CostDimensionId,
  type CostDrillStep,
} from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { useDataString } from "../i18n/data-strings.js";
import { DIMENSION_LABELS } from "./CostFilterEditor.js";
import { niceAxis, rowsExtent } from "../components/charts/nice-axis.js";
import { CostAnnotationModal } from "./CostAnnotationModal.js";
import {
  bucketCostAnnotations,
  costQueryForConfig,
  describeCostAnnotationScope,
  describeCostConversion,
  conversionRateForDay,
  formatCostAnnotationDates,
  type CostAnnotation,
  type CostAnnotationInput,
  type CostAnnotationMarker,
  type CostGraphConfig,
  type CostQueryResponse,
  isUnitCostConfig,
} from "./config.js";
import {
  alignComparison,
  COMPARISON_KEY,
  FORECAST_KEY,
  LABEL_KEY,
  SCENARIO_KEY,
  formatBucketLabel,
  formatMoney,
  pivotDimensionAxis,
  pivotSeries,
  spliceForecast,
  spliceScenario,
  type PivotedChart,
} from "./transform.js";
import type { CostApi } from "./types.js";
import { UnitCostCard } from "./UnitCostCard.js";
import { ArrowIcon, CloseIcon } from "../components/icons/ChromeIcons.js";

export interface CostGraphCardProps {
  title: string;
  config: CostGraphConfig;
  api: CostApi;
  /** Shown when some contributing account only has monthly-native data. */
  periodNativeNote?: boolean | undefined;
  onEdit?: (() => void) | undefined;
  /**
   * What the pencil does, for the tooltip and the accessible name. A saved
   * report's card doesn't edit anything in place (it opens the report) and a
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
   * Called with each loaded response's `conversion` block: `undefined` when
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
  /**
   * Save the drilled-down view as a new report, under the suggested name.
   *
   * Drilling is ephemeral: clicking a value narrows this card's view without
   * touching the saved report or widget. This is the one way to keep a view
   * somebody drilled into. Omitted where the host cannot create reports, which
   * hides the action rather than offering one that would fail.
   */
  onSaveAsReport?: ((config: CostGraphConfig, name: string) => Promise<void>) | undefined;
  /**
   * A bucket to draw attention to (`YYYY-MM-DD` for a daily chart): a shaded
   * band behind it, the way an anomaly breakdown marks the day it is about.
   * Drawn only when the chart has that bucket; it carries no data of its own.
   */
  highlightBucket?: string | undefined;
}

/** A value waiting for the user to say which dimension to drill into it by. */
interface PendingDrill {
  value: string;
  label: string;
}

interface LoadedState {
  response: CostQueryResponse;
  pivot: PivotedChart;
}

/**
 * "Drill into…": every drillable value as a native select, which is the
 * keyboard (and screen reader) route to what a pointer does by clicking a bar.
 * Resets to the prompt after each pick, so the same value can be picked again
 * after stepping back up.
 */
function DrillSelect({
  values,
  onPick,
  className = "w-28",
}: {
  values: ReadonlyArray<{ value: string; label: string }>;
  onPick: (value: { value: string; label: string }) => void;
  className?: string;
}) {
  const gt = useGT();
  return (
    <select
      value=""
      aria-label={gt("Drill into a value")}
      onChange={(e) => {
        const picked = values.find((v) => v.value === e.target.value);
        if (picked) onPick(picked);
      }}
      className={`${className} rounded border border-border bg-surface-sunken px-1 py-0.5 text-[11px] text-on-surface-secondary focus:outline-none focus:border-blue-500`}
    >
      <option value="">{gt("Drill into…")}</option>
      {values.map((v) => (
        <option key={v.value} value={v.value}>
          {v.label || v.value || gt("(no value)")}
        </option>
      ))}
    </select>
  );
}

/** The "break this value down by" choices, focused on open. */
function DrillChoices({
  label,
  choices,
  onChoose,
  onCancel,
  cancelLabel,
}: {
  label: string;
  choices: ReadonlyArray<{ dimension: CostDimensionId; label: string }>;
  onChoose: (dimension: CostDimensionId) => void;
  onCancel: () => void;
  cancelLabel: string;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-label={label}
      className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <span className="text-on-surface-faint">{label}</span>
      {choices.map((c, i) => (
        <button
          key={c.dimension}
          ref={i === 0 ? firstRef : undefined}
          type="button"
          onClick={() => onChoose(c.dimension)}
          className="rounded-full border border-border px-2 py-0.5 text-on-surface-secondary hover:border-border-strong focus-visible:border-border-strong"
        >
          {c.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onCancel}
        className="underline text-on-surface-faint hover:text-on-surface-secondary"
      >
        {cancelLabel}
      </button>
    </div>
  );
}

/**
 * A tick label short enough to sit under one bar. Dates are already short; a
 * dimension value can be a 60-character resource id, which would overprint
 * its neighbours. The tooltip and the table carry the full label.
 */
function truncateTick(label: string, truncate: boolean): string {
  if (!truncate || label.length <= 16) return label;
  return `${label.slice(0, 15)}…`;
}

/**
 * The spend chart: what a cost card has always drawn. Not exported: callers go
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
  onSaveAsReport,
  highlightBucket,
}: CostGraphCardProps) {
  const gt = useGT();
  const gtData = useDataString();
  const resolvedEditLabel = editLabel ?? gt("Edit widget");
  const chart = useChartTheme();
  /**
   * The values clicked through, outermost first. Local state on purpose: a
   * drill is a way of looking, not an edit, so the saved report or widget never
   * changes and a reload (or another viewer) sees the chart as saved.
   */
  const [drillPath, setDrillPath] = useState<CostDrillStep[]>([]);
  const [pendingDrill, setPendingDrill] = useState<PendingDrill | null>(null);
  const [saveState, setSaveState] = useState<
    { status: "idle" | "saving" | "saved" } | { status: "error"; message: string }
  >({ status: "idle" });
  // A different saved config is a different chart: whatever was drilled into
  // on the old one does not apply to it.
  useEffect(() => {
    setDrillPath([]);
    setPendingDrill(null);
    setSaveState({ status: "idle" });
  }, [config]);
  /** The config actually drawn: the saved one with the drill path applied. */
  const view = useMemo(() => applyCostDrillPath(config, drillPath), [config, drillPath]);
  /** Set by a bar's own click so the chart-wide click (annotations) skips it. */
  const markClickedRef = useRef(false);
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

  const request = useMemo(() => costQueryForConfig(view), [view]);
  const { bin, cumulative } = effectiveCostBinning(view);
  /** Draws period totals per group (pie, donut) rather than a time axis. */
  const totalsChart = isCostTotalsChart(view.chartType);
  const tableView = view.chartType === "table";

  /**
   * Held in a ref rather than listed in the fetch effect's dependencies: a
   * caller that passes an inline arrow (the ordinary way to write this) would
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
        // A dimension X axis is laid out by value, with the previous period
        // paired by value; nothing below (forecast, scenario) applies to it.
        if (response.xAxis && !totalsChart) {
          setState({ response, pivot: pivotDimensionAxis(response, view.binning) });
          onConversionRef.current?.(response.conversion);
          return;
        }
        const pivot = pivotSeries(response.series);
        if (response.comparison && !totalsChart) {
          alignComparison(pivot.rows, response.comparison);
        }
        // The table lists observed buckets only: a projected row would read as
        // a recorded figure in a grid of recorded figures.
        if (response.forecast && !totalsChart && !tableView) {
          spliceForecast(pivot, response, view.binning, cumulative);
        }
        // A second overlay, never a replacement for the first: the trend line
        // stays on the chart beside the scenario line so a reader can see what
        // the fit said before anybody's assumptions touched it.
        if (response.scenario && !totalsChart && !tableView) {
          spliceScenario(pivot, response, view.binning, cumulative);
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
  }, [api, request, totalsChart, tableView, view.binning, cumulative]);

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
  /** Values on the X axis instead of dates: annotations, which are dated, do not apply. */
  const dimensionAxis = Boolean(state?.response.xAxis) && !totalsChart;

  const markers: CostAnnotationMarker[] = useMemo(() => {
    if (!state || totalsChart || tableView || state.response.xAxis) return [];
    return bucketCostAnnotations(
      annotations,
      state.pivot.rows.map((r) => String(r["bucket"])),
      bin,
    );
  }, [annotations, state, bin, totalsChart, tableView]);

  const canWriteAnnotations =
    Boolean(api.createCostAnnotation && api.updateCostAnnotation && api.deleteCostAnnotation) &&
    !dimensionAxis;
  const openMarkerRow = markers.find((m) => m.bucket === openMarker) ?? null;

  /*
   * Drill-down. What a click narrows to is the value of the X axis dimension
   * on a dimension axis, otherwise the clicked series' group-by value; null
   * when the chart has nothing to narrow (ungrouped, count, unit cost).
   */
  const drillTarget = costDrillTarget(view);
  /**
   * The values a drill can start from, in the order the chart draws them:
   * the X axis values on a dimension axis, otherwise the series. "Other" is
   * left out because it is many values.
   */
  const drillValues = useMemo(() => {
    if (!state || !drillTarget) return [];
    if (state.response.xAxis && !totalsChart) {
      return state.response.xAxis.values
        .filter((v) => isCostDrillableValue(v.key))
        .map((v) => ({ value: v.key, label: v.label }));
    }
    return state.response.series
      .filter((s) => isCostDrillableValue(s.key))
      .filter((s, i, all) => all.findIndex((o) => o.key === s.key) === i)
      .map((s) => ({ value: s.key, label: s.label }));
  }, [state, drillTarget, totalsChart]);
  const canDrill = drillTarget !== null && drillValues.length > 0;

  const pushDrillStep = (step: CostDrillStep | null) => {
    if (!step) return;
    setDrillPath((path) => [...path, step]);
    setPendingDrill(null);
    setSaveState({ status: "idle" });
  };

  /**
   * Drill into one value: straight down the fixed hierarchy where there is
   * one, otherwise ask which dimension to break it down by (a tag has no
   * natural child, and a resource is the bottom of the hierarchy).
   */
  const drillInto = (value: string, label: string) => {
    if (!drillTarget || !isCostDrillableValue(value)) return;
    if (
      costDrillNeedsChoice(drillTarget.dimension) ||
      !nextCostDrillDimension(drillTarget.dimension)
    ) {
      setPendingDrill({ value, label });
      return;
    }
    pushDrillStep(resolveCostDrillStep(view, value, label));
  };

  const saveDrillAsReport = async () => {
    if (!onSaveAsReport) return;
    setSaveState({ status: "saving" });
    try {
      await onSaveAsReport(view, costDrillReportName(title || gt("Costs"), drillPath));
      setSaveState({ status: "saved" });
    } catch (e) {
      setSaveState({
        status: "error",
        message: e instanceof Error ? e.message : gt("Couldn't save the report"),
      });
    }
  };

  const currency = state?.response.currencies[0] ?? "USD";
  /**
   * Every value on the card goes through here: money for the cost measure, a
   * quantity with its unit for usage, a whole number for count. The response
   * says which, so a card can never print a count with a dollar sign.
   */
  const measure = state?.response.measure;
  const usageUnit = state?.response.usageUnit;
  const fmt = (value: number, cur: string = currency): string =>
    formatCostMeasureValue(value, { measure, currency: cur, usageUnit });
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
        .map(([cur, amt]) => fmt(amt, cur))
        .join(" + ")
    : null;
  const previousTotal =
    state?.response.previousTotals &&
    Object.entries(state.response.previousTotals)
      .map(([cur, amt]) => fmt(amt, cur))
      .join(" + ");
  /**
   * What the Y axis is, said under the title whenever it is not money: a
   * number with no currency sign could otherwise be read as dollars.
   */
  const measureCaption =
    measure === "usage"
      ? gt("Usage quantity in {unit}.", { unit: usageUnit ?? "" })
      : measure === "count"
        ? gt("Distinct values with nonzero cost per bin; the total counts each value once.")
        : null;

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
   * Categorical series colors: the app-wide chart theme order, assigned in
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

  /** A change in the card's own unit, signed: "+US$12.00", "−US$3.40". */
  const signedAmount = (change: number): string =>
    `${change > 0 ? "+" : change < 0 ? "−" : ""}${fmt(Math.abs(change))}`;

  /**
   * The previous-period figure for one tooltip row, with the change against
   * the current bucket's (or value's) total beside it, so a paired bar or a
   * point on the dashed line can be read without doing the subtraction.
   */
  const previousWithDelta = (previous: number, row: Record<string, unknown> | undefined) => {
    const current = (state?.pivot.series ?? []).reduce((sum, def) => {
      const v = row?.[def.dataKey];
      return sum + (typeof v === "number" ? v : 0);
    }, 0);
    const delta = costComparisonDelta(current, previous);
    return delta
      ? `${fmt(previous)} (${signedAmount(delta.change)}, ${formatCostChangePct(delta.changePct)})`
      : fmt(previous);
  };

  // The chart body is exposed as a single role="img" with a summary label
  // only when a chart is actually rendered: loading, error, and empty
  // states keep their own text visible to assistive tech.
  const hasChartData = !loading && !error && (state?.pivot.rows.length ?? 0) > 0;
  /** The "Drill into…" select sits in the rail until a drill starts. */
  const showRailDrill = canDrill && hasChartData && drillPath.length === 0;

  /**
   * The table view: one row per bucket, a column per series, the bucket total
   * and (when comparing) the previous period's total for the same position.
   * Real table semantics, so it reads cell by cell with a screen reader rather
   * than as one opaque image.
   */
  const renderTable = (pivot: PivotedChart) => {
    const comparing = Boolean(state?.response.comparison);
    // On a date axis a drill starts from a series (a column); on a dimension
    // axis from a value (a row). Either way it is a real button, so the table
    // is the keyboard route into the same drill a bar click takes.
    const drillColumns = canDrill && !dimensionAxis;
    const drillRows = canDrill && dimensionAxis;
    const drillButton = (value: string, label: string) => (
      <button
        type="button"
        onClick={() => drillInto(value, label)}
        title={gt("Drill into {value}", { value: label })}
        className="underline decoration-dotted underline-offset-2 hover:text-on-surface focus-visible:text-on-surface"
      >
        {label}
      </button>
    );
    return (
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-surface-raised">
            <tr className="text-on-surface-faint">
              <th scope="col" className="text-left font-medium py-1 pr-3">
                {dimensionAxis
                  ? gtData(DIMENSION_LABELS[state!.response.xAxis!.dimension])
                  : gt("Period")}
              </th>
              {pivot.series.map((def) => (
                <th key={def.dataKey} scope="col" className="text-right font-medium py-1 px-2">
                  {drillColumns && isCostDrillableValue(def.key)
                    ? drillButton(def.key, def.label)
                    : def.label}
                </th>
              ))}
              {pivot.series.length > 1 && (
                <th scope="col" className="text-right font-medium py-1 px-2">
                  {gt("Total")}
                </th>
              )}
              {comparing && (
                <>
                  <th scope="col" className="text-right font-medium py-1 px-2">
                    {gt("Previous period")}
                  </th>
                  <th scope="col" className="text-right font-medium py-1 px-2">
                    {gt("Change")}
                  </th>
                  <th scope="col" className="text-right font-medium py-1 pl-2">
                    {gt("Change %")}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {pivot.rows.map((row) => {
              const bucket = String(row["bucket"]);
              const rowLabel = dimensionAxis
                ? String(row[LABEL_KEY] ?? bucket)
                : formatBucketLabel(bucket, bin);
              const values = pivot.series.map((def) => row[def.dataKey]);
              const rowTotal = values.reduce<number>(
                (sum, v) => sum + (typeof v === "number" ? v : 0),
                0,
              );
              const previous = row[COMPARISON_KEY];
              const delta = costComparisonDelta(
                rowTotal,
                typeof previous === "number" ? previous : null,
              );
              return (
                <tr key={bucket} className="border-t border-border text-on-surface-secondary">
                  <th scope="row" className="text-left font-normal py-1 pr-3 whitespace-nowrap">
                    {drillRows && isCostDrillableValue(bucket)
                      ? drillButton(bucket, rowLabel)
                      : rowLabel}
                  </th>
                  {values.map((v, i) => (
                    <td key={pivot.series[i]!.dataKey} className="text-right py-1 px-2">
                      {typeof v === "number" ? fmt(v, pivot.series[i]!.currency) : "–"}
                    </td>
                  ))}
                  {pivot.series.length > 1 && (
                    <td className="text-right py-1 px-2 text-on-surface">{fmt(rowTotal)}</td>
                  )}
                  {comparing && (
                    <>
                      <td className="text-right py-1 px-2 text-on-surface-faint">
                        {typeof previous === "number" ? fmt(previous) : "–"}
                      </td>
                      <td
                        className={`text-right py-1 px-2 ${delta && delta.change > 0 ? "text-danger" : delta && delta.change < 0 ? "text-success" : "text-on-surface-faint"}`}
                      >
                        {delta ? signedAmount(delta.change) : "–"}
                      </td>
                      <td
                        className={`text-right py-1 pl-2 ${delta && delta.change > 0 ? "text-danger" : delta && delta.change < 0 ? "text-success" : "text-on-surface-faint"}`}
                      >
                        {delta ? formatCostChangePct(delta.changePct) : "–"}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

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

    if (tableView) return renderTable(pivot);

    if (totalsChart) {
      const slices = response.series.map((s, i) => ({
        name: s.label,
        value: costSeriesTotal(s.points, cumulative),
        fill: colorFor(i, s.key === "__other__"),
      }));
      const donut = view.chartType === "donut";
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={donut ? "55%" : 0}
              outerRadius="80%"
              paddingAngle={2}
              stroke="none"
              {...(canDrill
                ? {
                    // A slice is a group-by value: clicking it drills into it.
                    onClick: (_slice: unknown, index: number) => {
                      const s = response.series[index];
                      if (s) drillInto(s.key, s.label);
                    },
                    cursor: "pointer",
                  }
                : {})}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value, name) => [fmt(Number(value)), String(name)]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => <span style={{ color: chart.tick }}>{value}</span>}
            />
            {/* The donut's hole carries the figure the ring divides up. */}
            {donut && total ? (
              <text
                x="50%"
                y="45%"
                textAnchor="middle"
                dominantBaseline="middle"
                fill={chart.tick}
                fontSize={13}
                fontWeight={600}
              >
                {total}
              </text>
            ) : null}
          </PieChart>
        </ResponsiveContainer>
      );
    }

    const isBar = view.chartType === "stacked_bar" || view.chartType === "multi_bar";
    const stacked = view.chartType === "stacked_bar" || view.chartType === "area";
    /**
     * The previous period as a muted bar beside each current one, instead of
     * the dashed line. Bar charts only: a bar paired with a point on a line is
     * two different marks pretending to be one comparison.
     */
    const pairedBars = Boolean(response.comparison) && isBar && view.comparisonStyle === "bars";
    /** Display label per dimension value, for the X axis ticks and tooltip. */
    const valueLabels = new Map(
      dimensionAxis ? pivot.rows.map((r) => [String(r["bucket"]), String(r[LABEL_KEY])]) : [],
    );
    const categoryLabel = (b: string): string =>
      dimensionAxis ? (valueLabels.get(b) ?? b) : formatBucketLabel(b, bin);
    /**
     * A bar's own click: drill into the value it stands for. On a dimension
     * axis that is the bar's X value whichever segment was hit; on a date
     * axis it is the series the segment belongs to.
     */
    const onBarClick = (def: (typeof pivot.series)[number], payload: unknown) => {
      if (!canDrill) return;
      if (canWriteAnnotations) markClickedRef.current = true;
      if (dimensionAxis) {
        const row = (payload as { payload?: Record<string, unknown> } | undefined)?.payload;
        const key = row?.["bucket"];
        if (typeof key === "string") drillInto(key, String(row?.[LABEL_KEY] ?? key));
      } else {
        drillInto(def.key, def.label);
      }
    };

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
                // below the chart: this is the pointer shortcut, not the only
                // way in.
                onClick: (nextState: { activeLabel?: string | number | undefined }) => {
                  // A bar's own click already drilled; this is the same click
                  // bubbling up, not a request for a note.
                  if (markClickedRef.current) {
                    markClickedRef.current = false;
                    return;
                  }
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
            tickFormatter={(b: string) => truncateTick(categoryLabel(b), dimensionAxis)}
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            // Every value is its own bar on a dimension axis, so each one gets
            // its label while they fit; dates skip ticks the way they always have.
            {...(dimensionAxis && pivot.rows.length <= 12
              ? { interval: 0 }
              : { minTickGap: dimensionAxis ? 8 : 24 })}
          />
          <YAxis
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            tickFormatter={(v: number) => fmt(v)}
            domain={yScale.domain}
            ticks={yScale.ticks}
            width={70}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(b) => {
              const label = categoryLabel(String(b));
              // A value spans the whole range, so no single day's rate is behind it.
              if (dimensionAxis) return label;
              // Name the rate behind this bucket's converted amounts, with its
              // source and date, so a single bar can be checked by hand.
              const rates = (response.conversion?.converted ?? []).flatMap((entry) => {
                const applied = conversionRateForDay(entry, String(b));
                return applied
                  ? [
                      gt("{from} to {to} at {rate} ({source}, {date})", {
                        from: entry.currency,
                        to: response.conversion!.displayCurrency,
                        rate: applied.rate,
                        source:
                          applied.source === "ecb" ? gt("ECB reference rate") : gt("your rate"),
                        date: applied.effectiveFrom,
                      }),
                    ]
                  : [];
              });
              return rates.length > 0 ? `${label} · ${rates.join("; ")}` : label;
            }}
            formatter={(value, name, item) => {
              if (String(name) === COMPARISON_KEY) {
                const row = (item as { payload?: Record<string, unknown> } | undefined)?.payload;
                return [previousWithDelta(Number(value), row), gt("Previous period")];
              }
              const label =
                String(name) === COMPARISON_KEY
                  ? gt("Previous period")
                  : String(name) === FORECAST_KEY
                    ? gt("Forecast (trend)")
                    : String(name) === SCENARIO_KEY
                      ? scenarioLabel
                      : (pivot.series.find((s) => s.dataKey === String(name))?.label ??
                        String(name));
              return [fmt(Number(value)), label];
            }}
          />
          {pivot.series.length > 1 && (
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              // On a date axis the legend entries are the series: clicking one
              // drills into it, which is the only pointer route on a line or
              // area chart (they have no bars to click).
              {...(canDrill && !dimensionAxis
                ? {
                    onClick: (entry: { dataKey?: unknown }) => {
                      const def = pivot.series.find((s) => s.dataKey === entry.dataKey);
                      if (def) drillInto(def.key, def.label);
                    },
                  }
                : {})}
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
          {/*
            Paired previous-period bars come first, so each pair reads left to
            right as "then, now". Their own stack id keeps them beside a
            stacked current bar rather than piled on top of it.
          */}
          {pairedBars && (
            <Bar
              dataKey={COMPARISON_KEY}
              name={COMPARISON_KEY}
              {...(stacked ? { stackId: "previous" } : {})}
              fill={chart.tick}
              fillOpacity={0.3}
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
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
                {...(canDrill
                  ? {
                      onClick: (data: unknown) => onBarClick(def, data),
                      cursor: "pointer",
                    }
                  : {})}
              />
            ) : view.chartType === "area" ? (
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
          {response.comparison && !pairedBars && (
            <Line
              type="monotone"
              dataKey={COMPARISON_KEY}
              name={COMPARISON_KEY}
              stroke={chart.tick}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              // Values on a dimension axis are separate things, not moments in
              // a sequence: a dot marks each one's previous figure.
              dot={dimensionAxis ? { r: 2.5, fill: chart.tick } : false}
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
            with no annotations at all: `ifOverflow="hidden"` keeps that true
            even if a bucket ever went missing between the two renders.
          */}
          {highlightBucket && (
            <ReferenceArea
              x1={highlightBucket}
              x2={highlightBucket}
              ifOverflow="hidden"
              fill={chart.tick}
              fillOpacity={0.18}
              stroke={chart.tick}
              strokeOpacity={0.5}
              strokeDasharray="3 3"
            />
          )}
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
            <CloseIcon size={12} />
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
            a falsy left-hand side that React can render (a `0`, an empty
            string) would print beside the title and read as a real figure.
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
              className={`inline-flex items-center gap-0.5 text-xs flex-shrink-0 ${deltaPct > 0 ? "text-danger" : "text-success"}`}
              title={
                previousTotal ? gt("Previous period: {total}", { total: previousTotal }) : undefined
              }
            >
              <ArrowIcon direction={deltaPct > 0 ? "up" : "down"} size={11} />
              {Math.abs(deltaPct).toFixed(1)}%
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
            {gt("Billing rules applied; collected spend {total}.", { total: adjustedRawTotal })}
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
        {measureCaption && (
          <p className="text-[11px] text-on-surface-faint mt-0.5">{measureCaption}</p>
        )}
        {(mixedCurrency || periodNativeNote || conversionNote) && (
          <p className="text-[11px] text-on-surface-faint mt-0.5">
            {mixedCurrency && gt("Mixed currencies, shown per currency. ")}
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
        {/*
          The drill path, once there is one: where this view sits under the
          saved chart, each level a way back up, plus the way to keep it.
          Outside the role="img" chart body so every control is reachable.
        */}
        {drillPath.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <nav aria-label={gt("Drill-down path")}>
              <ol className="flex flex-wrap items-center gap-1 text-on-surface-faint">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setDrillPath([]);
                      setPendingDrill(null);
                      setSaveState({ status: "idle" });
                    }}
                    className="underline hover:text-on-surface-secondary"
                  >
                    {gt("All")}
                  </button>
                </li>
                {drillPath.map((step, i) => {
                  const label = step.label || step.value || gt("(no value)");
                  return (
                    <li key={`${i}-${step.value}`} className="flex items-center gap-1">
                      <span aria-hidden>›</span>
                      {i === drillPath.length - 1 ? (
                        <span aria-current="page" className="text-on-surface-secondary">
                          {label}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDrillPath((path) => path.slice(0, i + 1));
                            setPendingDrill(null);
                            setSaveState({ status: "idle" });
                          }}
                          className="underline hover:text-on-surface-secondary"
                        >
                          {label}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
            {canDrill && (
              <DrillSelect
                values={drillValues}
                onPick={(v) => drillInto(v.value, v.label)}
                className=""
              />
            )}
            {onSaveAsReport && (
              <button
                type="button"
                onClick={() => void saveDrillAsReport()}
                disabled={saveState.status === "saving"}
                className="rounded border border-border px-1.5 py-0.5 text-on-surface-secondary hover:border-border-strong disabled:opacity-50"
              >
                {saveState.status === "saving" ? gt("Saving…") : gt("Save as new report")}
              </button>
            )}
            {saveState.status === "saved" && (
              <span role="status" className="text-success">
                {gt("Saved as a new report.")}
              </span>
            )}
            {saveState.status === "error" && (
              <span role="alert" className="text-danger">
                {saveState.message}
              </span>
            )}
          </div>
        )}
        {/*
          A value whose next level is the reader's choice (a tag has no natural
          child; a resource is the bottom of the hierarchy). Focus moves to the
          first choice, so a keyboard drill continues without hunting for it.
        */}
        {pendingDrill && drillTarget && (
          <DrillChoices
            label={gt("Break {value} down by:", {
              value: pendingDrill.label || pendingDrill.value || gt("(no value)"),
            })}
            choices={costDrillChoices(drillTarget.dimension).map((d) => ({
              dimension: d,
              label: gtData(DIMENSION_LABELS[d]),
            }))}
            onChoose={(dimension) =>
              pushDrillStep(
                resolveCostDrillStep(view, pendingDrill.value, pendingDrill.label, { dimension }),
              )
            }
            onCancel={() => setPendingDrill(null)}
            cancelLabel={gt("Cancel")}
          />
        )}
      </div>

      <div
        className="flex-1 min-h-0 px-3 pb-3 flex flex-col"
        role={hasChartData && !tableView ? "img" : undefined}
        aria-label={hasChartData && !tableView ? chartAriaLabel : undefined}
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
        The annotation rail: deliberately outside the `role="img"` chart body,
        which would hide these controls from assistive tech, and deliberately
        not a hover affordance. The numbered flags on the chart are the visual
        marker; this is how they are read and reached with a keyboard, on a
        phone, and by anyone who never hovers anything.
      */}
      {(markers.length > 0 || (canWriteAnnotations && hasChartData) || showRailDrill) && (
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
                    // Default to the chart's last bucket: the thing somebody
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
            {/*
              The keyboard route into a drill: the same narrowing a click on a
              bar, slice, legend entry or table heading does. Moves up into the
              path bar once a drill has started.
            */}
            {showRailDrill && (
              <DrillSelect
                values={drillValues}
                onPick={(v) => drillInto(v.value, v.label)}
                className="ml-auto w-32"
              />
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
                      {annotation.budgetAlert ? gt(" · Explains a budget alert") : ""}
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
 * A cost card: spend over time, or (when the config names a business metric)
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
  if (isUnitCostConfig(props.config)) {
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

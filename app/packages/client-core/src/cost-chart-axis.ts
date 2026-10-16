/**
 * Cost chart axes, period comparison and drill-down: **pure**. No fetching, no
 * React, no DOM, so web (recharts), mobile (react-native-svg), the PDF renderer
 * and the server all draw a dimension axis, pair two periods and resolve a
 * drill path through the same functions.
 *
 * Three pieces:
 *
 * - {@link pivotCostGroupsToDimensionAxis}: the server half. The reader scans
 *   with the X dimension in the group key (and a segment dimension after it,
 *   joined by {@link COST_X_SEGMENT_SEPARATOR}); this turns those date-bucketed
 *   groups into series keyed by X value, ranks the values, and folds the tail
 *   into "Other". Dates stay in the scan until here so currency conversion can
 *   still pick each day's rate.
 * - {@link costCategoryChart}: the client half. Any response (date axis or
 *   dimension axis) becomes one matrix of categories × series with the
 *   previous period paired onto each category, which every renderer draws.
 * - The drill path: {@link costDrillTarget}, {@link nextCostDrillDimension},
 *   {@link applyCostDrillPath}. Clicking a value narrows the chart to it and
 *   regroups by the next sensible dimension, without touching the saved config.
 */
import {
  COST_DIMENSIONS,
  OTHER_GROUP_KEY,
  formatBucketLabel,
  isKeyedCostDimension,
  totalPerBucket,
  type CostBinningId,
  type CostDimensionId,
  type CostFilter,
  type CostGraphConfig,
  type CostQueryResponse,
  type CostSeriesPoint,
} from "./costs";

/* ------------------------------------------------------------------ *
 * Server half: date-bucketed groups → series keyed by X value.
 * ------------------------------------------------------------------ */

/**
 * Joins the X value and the segment value in a two-dimension group key
 * (ASCII unit separator). The X value comes first and the split is on the
 * first occurrence, so a segment value containing it survives intact.
 */
export const COST_X_SEGMENT_SEPARATOR = "\u001f";

/** The minimum a scanned group needs: matches the reader's `CostSeriesGroup`. */
export interface DimensionAxisGroup {
  key: string;
  currency: string;
  points: readonly CostSeriesPoint[];
}

/** One series of a dimension-axis pivot: points keyed by X value. */
export interface DimensionAxisSeries {
  /** Segment value, date bin start (`date`), or "" (`none`). `"__other__"` folds. */
  key: string;
  currency: string;
  points: CostSeriesPoint[];
}

export interface DimensionAxisPivot {
  /** X values in drawing order: ranked by spend, then `"__other__"`. */
  categories: string[];
  series: DimensionAxisSeries[];
}

export interface DimensionAxisPivotOptions {
  /**
   * What the scanned group key holds after the X value: a segment dimension's
   * value (`dimension`), nothing with each date bin a segment (`date`), or
   * nothing at all (`none`).
   */
  segment: "none" | "dimension" | "date";
  /** X values beyond this many fold into "Other"; so do segments, for `dimension`. */
  topN: number;
  /**
   * Fold onto exactly these X values instead of ranking: how a previous
   * period is laid onto the current period's axis, so a value that fell out of
   * the top N last period is still compared with itself rather than with
   * whatever "Other" happened to hold.
   */
  keepCategories?: readonly string[] | undefined;
}

/**
 * Turn groups scanned per (date bin, X value[, segment value], currency) into
 * series whose points are keyed by X value.
 *
 * Ranking sums amounts across currencies as numbers. A mixed-currency org that
 * has not asked for conversion therefore ranks by face value, which is the
 * same approximation the legend order has always made; converting first (the
 * service does, when asked) makes it exact.
 */
export function pivotCostGroupsToDimensionAxis(
  groups: readonly DimensionAxisGroup[],
  opts: DimensionAxisPivotOptions,
): DimensionAxisPivot {
  const topN = Math.max(1, Math.floor(opts.topN));
  /** x → segment → currency → amount */
  const cells = new Map<string, Map<string, Map<string, number>>>();
  const xTotals = new Map<string, number>();
  const segTotals = new Map<string, number>();

  for (const g of groups) {
    let x = g.key;
    let seg = "";
    if (opts.segment === "dimension") {
      const at = g.key.indexOf(COST_X_SEGMENT_SEPARATOR);
      if (at >= 0) {
        x = g.key.slice(0, at);
        seg = g.key.slice(at + COST_X_SEGMENT_SEPARATOR.length);
      }
    }
    for (const p of g.points) {
      const segKey = opts.segment === "date" ? p.bucket : seg;
      const bySeg = cells.get(x) ?? new Map<string, Map<string, number>>();
      cells.set(x, bySeg);
      const byCur = bySeg.get(segKey) ?? new Map<string, number>();
      bySeg.set(segKey, byCur);
      byCur.set(g.currency, (byCur.get(g.currency) ?? 0) + p.amount);
      xTotals.set(x, (xTotals.get(x) ?? 0) + p.amount);
      segTotals.set(segKey, (segTotals.get(segKey) ?? 0) + p.amount);
    }
  }

  const ranked = (totals: Map<string, number>) =>
    [...totals.entries()]
      .sort(([ak, a], [bk, b]) => b - a || (ak < bk ? -1 : ak > bk ? 1 : 0))
      .map(([k]) => k);

  // X values: the kept set, then "Other" when anything folded into it.
  let kept: string[];
  if (opts.keepCategories) {
    kept = opts.keepCategories.filter((k) => k !== OTHER_GROUP_KEY);
  } else {
    kept = ranked(xTotals)
      .filter((k) => k !== OTHER_GROUP_KEY)
      .slice(0, topN);
  }
  const keptSet = new Set(kept);
  const xOf = (x: string) => (keptSet.has(x) ? x : OTHER_GROUP_KEY);
  const anyFolded = [...xTotals.keys()].some((x) => !keptSet.has(x));
  const categories =
    anyFolded || opts.keepCategories?.includes(OTHER_GROUP_KEY) ? [...kept, OTHER_GROUP_KEY] : kept;

  // Segments: ranked top N + Other for a dimension, chronological for dates.
  let segOrder: string[];
  let segOf: (s: string) => string;
  if (opts.segment === "dimension") {
    const segRanked = ranked(segTotals).filter((k) => k !== OTHER_GROUP_KEY);
    const segKept = new Set(segRanked.slice(0, topN));
    segOf = (s) => (segKept.has(s) ? s : OTHER_GROUP_KEY);
    segOrder = [...segRanked.slice(0, topN)];
    if (segRanked.length > topN || segTotals.has(OTHER_GROUP_KEY)) segOrder.push(OTHER_GROUP_KEY);
  } else {
    segOf = (s) => s;
    segOrder = [...segTotals.keys()].sort();
  }

  /** segment → currency → x → amount, in folded keys */
  const folded = new Map<string, Map<string, Map<string, number>>>();
  for (const [x, bySeg] of cells) {
    const fx = xOf(x);
    for (const [s, byCur] of bySeg) {
      const fs = segOf(s);
      const byCurrency = folded.get(fs) ?? new Map<string, Map<string, number>>();
      folded.set(fs, byCurrency);
      for (const [cur, amount] of byCur) {
        const byX = byCurrency.get(cur) ?? new Map<string, number>();
        byCurrency.set(cur, byX);
        byX.set(fx, (byX.get(fx) ?? 0) + amount);
      }
    }
  }

  const series: DimensionAxisSeries[] = [];
  for (const s of segOrder) {
    const byCurrency = folded.get(s);
    if (!byCurrency) continue;
    for (const cur of [...byCurrency.keys()].sort()) {
      const byX = byCurrency.get(cur)!;
      series.push({
        key: s,
        currency: cur,
        points: categories
          .filter((c) => byX.has(c))
          .map((c) => ({ bucket: c, amount: roundAmount(byX.get(c)!) })),
      });
    }
  }
  return { categories, series };
}

/** Six places, like the currency converter: sums of sums drift otherwise. */
function roundAmount(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Split a two-dimension group key back into its X and segment halves. */
export function splitCostXSegmentKey(key: string): { x: string; segment: string } {
  const at = key.indexOf(COST_X_SEGMENT_SEPARATOR);
  if (at < 0) return { x: key, segment: "" };
  return { x: key.slice(0, at), segment: key.slice(at + COST_X_SEGMENT_SEPARATOR.length) };
}

/* ------------------------------------------------------------------ *
 * Client half: any response → categories × series, previous paired.
 * ------------------------------------------------------------------ */

export interface CostChartCategory {
  /** Date bin start on a date axis; dimension value on a dimension axis. */
  key: string;
  /** Ready to print: a formatted bin, or the server's label for the value. */
  label: string;
  isOther: boolean;
}

export interface CostChartMatrixSeries {
  key: string;
  label: string;
  currency: string;
  isOther: boolean;
  /** One per category; null where the series has nothing there. */
  values: Array<number | null>;
}

export interface CostCategoryChart {
  axis: "date" | "dimension";
  categories: CostChartCategory[];
  series: CostChartMatrixSeries[];
  /** Sum of every series per category. */
  totals: number[];
  /**
   * The previous period per category, or null when the response carries no
   * comparison. Paired by position on a date axis (bin #n onto bin #n, the
   * rule the dashed line has always used) and by value on a dimension axis.
   */
  previous: Array<number | null> | null;
}

/**
 * Lay a response out as categories × series, whichever axis it was drawn on.
 *
 * `binning` formats date categories (and date segments on a dimension axis).
 * Series order is the response's, which is ranked with "Other" last, so a
 * renderer assigning colors by index keeps them stable across refreshes.
 */
export function costCategoryChart(
  response: CostQueryResponse,
  binning: CostBinningId,
): CostCategoryChart {
  const mixed = new Set(response.series.map((s) => s.currency)).size > 1;
  const dateSegments = response.xAxis?.segment === "date";
  const seriesLabel = (s: CostQueryResponse["series"][number]) => {
    const base = dateSegments ? formatBucketLabel(s.key, binning) : s.label;
    return mixed && s.currency ? `${base} (${s.currency})` : base;
  };

  let categories: CostChartCategory[];
  if (response.xAxis) {
    categories = response.xAxis.values.map((v) => ({
      key: v.key,
      label: v.label,
      isOther: v.key === OTHER_GROUP_KEY,
    }));
  } else {
    const buckets = [...new Set(response.series.flatMap((s) => s.points.map((p) => p.bucket)))];
    buckets.sort();
    categories = buckets.map((b) => ({
      key: b,
      label: formatBucketLabel(b, binning),
      isOther: false,
    }));
  }
  const index = new Map(categories.map((c, i) => [c.key, i]));

  const series: CostChartMatrixSeries[] = response.series.map((s) => {
    const values = new Array<number | null>(categories.length).fill(null);
    for (const p of s.points) {
      const at = index.get(p.bucket);
      if (at !== undefined) values[at] = (values[at] ?? 0) + p.amount;
    }
    return {
      key: s.key,
      label: seriesLabel(s),
      currency: s.currency,
      isOther: s.key === OTHER_GROUP_KEY,
      values,
    };
  });

  const totals = categories.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));

  let previous: Array<number | null> | null = null;
  if (response.comparison) {
    if (response.xAxis) {
      const byKey = new Map<string, number>();
      for (const s of response.comparison) {
        for (const p of s.points) byKey.set(p.bucket, (byKey.get(p.bucket) ?? 0) + p.amount);
      }
      previous = categories.map((c) => byKey.get(c.key) ?? null);
    } else {
      const prev = totalPerBucket(response.comparison);
      previous = categories.map((_, i) => prev[i]?.amount ?? null);
    }
  }

  return { axis: response.xAxis ? "dimension" : "date", categories, series, totals, previous };
}

/** Current against previous: the absolute change and, when defined, the percentage. */
export interface CostComparisonDelta {
  change: number;
  /** Null when the previous figure is zero: a percentage of nothing is no number. */
  changePct: number | null;
}

/**
 * The change from `previous` to `current`, or null when there is no previous
 * figure to compare with at all (a value new this period on a dimension axis,
 * or a bin past the end of the previous period).
 */
export function costComparisonDelta(
  current: number,
  previous: number | null | undefined,
): CostComparisonDelta | null {
  if (previous === null || previous === undefined) return null;
  const change = current - previous;
  return { change, changePct: previous === 0 ? null : (change / Math.abs(previous)) * 100 };
}

/** A change percentage as printed in tooltips, tables and the PDF: "+12.3%". */
export function formatCostChangePct(changePct: number | null): string {
  if (changePct === null) return "–";
  const sign = changePct > 0 ? "+" : changePct < 0 ? "−" : "";
  return `${sign}${Math.abs(changePct).toFixed(1)}%`;
}

/* ------------------------------------------------------------------ *
 * Drill-down.
 * ------------------------------------------------------------------ */

/** A dimension a chart is grouped (or drilled) by, with its key when keyed. */
export interface CostDrillDimension {
  dimension: CostDimensionId;
  tagKey?: string | undefined;
}

/**
 * One step down: narrow to `value` of `from`, then regroup by `to`.
 *
 * The label is carried so breadcrumbs and a saved report's name read as the
 * value the user clicked ("Amazon Web Services"), not its key ("aws").
 */
export interface CostDrillStep {
  from: CostDrillDimension;
  value: string;
  label: string;
  to: CostDrillDimension;
}

/**
 * The fixed drill order for dimensions that have an obvious child. Spend
 * narrows from who bills it, to what was bought, to where it ran, to the
 * thing itself:
 *
 *   provider → service → region → resource
 *   account → service, charge type → service, commitment → resource
 *
 * There is no resource-type dimension in the cost store (rows carry a
 * service, a region and a resource id), so region is the level between a
 * service and its resources. A resource is the leaf. Tags and virtual tags
 * have no natural child, so the next dimension is the user's choice
 * ({@link costDrillChoices}); a hierarchical key would slot in here.
 */
export const COST_DRILL_HIERARCHY: Readonly<Partial<Record<CostDimensionId, CostDimensionId>>> = {
  provider: "service",
  account: "service",
  service: "region",
  region: "resource",
  charge_type: "service",
  commitment: "resource",
};

/**
 * The dimension a click on this chart drills on, or null when nothing on it
 * is drillable: the X axis value on a dimension axis, otherwise the series'
 * group-by value. Ungrouped charts, count charts (one synthetic series) and
 * unit-cost charts have no value to narrow to.
 */
export function costDrillTarget(config: CostGraphConfig): CostDrillDimension | null {
  if (config.unitCostMetricId || config.unitCostMode === "usage_unit_cost") return null;
  if (config.xAxis) {
    return {
      dimension: config.xAxis,
      ...(config.xAxisTagKey ? { tagKey: config.xAxisTagKey } : {}),
    };
  }
  if (config.groupBy === "none" || config.measure === "count") return null;
  return {
    dimension: config.groupBy,
    ...(config.groupByTagKey ? { tagKey: config.groupByTagKey } : {}),
  };
}

/**
 * The next dimension after drilling into a value of `dimension`, or null when
 * the user has to choose (a tag, a virtual tag) or there is nowhere further
 * to go (a resource).
 */
export function nextCostDrillDimension(dimension: CostDimensionId): CostDimensionId | null {
  return COST_DRILL_HIERARCHY[dimension] ?? null;
}

/** Whether drilling into `dimension` needs the user to pick where to go next. */
export function costDrillNeedsChoice(dimension: CostDimensionId): boolean {
  return isKeyedCostDimension(dimension);
}

/**
 * The dimensions offered in the "drill into … by" menu: every unkeyed
 * dimension except the one being drilled from. Keyed dimensions are left out
 * because they would need a second picker for the key inside a menu; a tag
 * can still be regrouped by from the chart's editor.
 */
export function costDrillChoices(from: CostDimensionId): CostDimensionId[] {
  return COST_DIMENSIONS.filter((d) => d !== from && !isKeyedCostDimension(d));
}

/** Whether a clicked value can be drilled into at all. */
export function isCostDrillableValue(value: string): boolean {
  // "Other" is many values: there is no single one to narrow to.
  return value !== OTHER_GROUP_KEY;
}

/**
 * The step a click resolves to, or null when it cannot drill: the value is
 * "Other", the chart has no drill target, or the target is a leaf and no
 * `to` was chosen.
 */
export function resolveCostDrillStep(
  config: CostGraphConfig,
  value: string,
  label: string,
  to?: CostDrillDimension,
): CostDrillStep | null {
  const from = costDrillTarget(config);
  if (!from || !isCostDrillableValue(value)) return null;
  const next = to ?? nextFixed(from.dimension);
  if (!next) return null;
  return { from, value, label, to: next };
}

function nextFixed(dimension: CostDimensionId): CostDrillDimension | null {
  const next = nextCostDrillDimension(dimension);
  return next ? { dimension: next } : null;
}

function sameDimension(a: CostDrillDimension, b: CostDrillDimension): boolean {
  return a.dimension === b.dimension && (a.tagKey ?? "") === (b.tagKey ?? "");
}

/**
 * The config one step down: `value` added as an `in` filter (replacing any
 * existing `in` filter on the same dimension, which it can only narrow), and
 * the drilled axis regrouped by `to`. On a dimension X axis it is the X axis
 * that moves; a segment that would then equal it is dropped.
 */
export function applyCostDrillStep(config: CostGraphConfig, step: CostDrillStep): CostGraphConfig {
  const filter: CostFilter = {
    dimension: step.from.dimension,
    op: "in",
    values: [step.value],
    ...(step.from.tagKey ? { tagKey: step.from.tagKey } : {}),
  };
  const filters = [
    ...config.filters.filter(
      (f) =>
        !(f.op === "in" && sameDimension({ dimension: f.dimension, tagKey: f.tagKey }, step.from)),
    ),
    filter,
  ];
  const next: CostGraphConfig = { ...config, filters };
  if (config.xAxis) {
    next.xAxis = step.to.dimension;
    if (step.to.tagKey) next.xAxisTagKey = step.to.tagKey;
    else delete next.xAxisTagKey;
    if (
      next.groupBy !== "none" &&
      sameDimension({ dimension: next.groupBy, tagKey: next.groupByTagKey }, step.to)
    ) {
      next.groupBy = "none";
      delete next.groupByTagKey;
    }
  } else {
    next.groupBy = step.to.dimension;
    if (step.to.tagKey) next.groupByTagKey = step.to.tagKey;
    else delete next.groupByTagKey;
  }
  return next;
}

/** Apply a whole drill path to the saved config; the empty path is the config itself. */
export function applyCostDrillPath(
  config: CostGraphConfig,
  steps: readonly CostDrillStep[],
): CostGraphConfig {
  return steps.reduce(applyCostDrillStep, config);
}

/**
 * The name a drilled view is saved under: the report's name and the values
 * drilled through, trimmed to `maxLength` from the front of the path so the
 * deepest (most specific) value survives.
 */
export function costDrillReportName(
  baseName: string,
  steps: readonly CostDrillStep[],
  maxLength = 200,
): string {
  if (steps.length === 0) return baseName.slice(0, maxLength);
  const labels = steps.map((s) => s.label || s.value || "(none)");
  let name = `${baseName} › ${labels.join(" › ")}`;
  while (name.length > maxLength && labels.length > 1) {
    labels.shift();
    name = `${baseName} › … › ${labels.join(" › ")}`;
  }
  return name.length > maxLength ? name.slice(0, maxLength) : name;
}

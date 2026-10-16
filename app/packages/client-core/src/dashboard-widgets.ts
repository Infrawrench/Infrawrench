/**
 * KPI and text dashboard widgets, and the rules of the resizable grid.
 *
 * A `kpi` card is one big number with a period-over-period change badge. Like
 * a canvas KPI block it stores a *question*, never a number: the server
 * (`web/src/services/dashboard-kpi.ts`) re-answers it on every read through
 * the service the source's own card uses, inside the reader's cost
 * visibility scope, so the tile can never show more than its reader could
 * query by hand. The source is always picked (a saved report, a budget, the
 * org's commitments, its realized savings): no field takes a query string.
 *
 * A `text` card is markdown the dashboard's editors wrote. It is stored as
 * typed and sanitised where it is drawn (react-markdown with no raw HTML on
 * web and desktop, the native `ChatMarkdown` on mobile, plain lines in a PDF).
 *
 * Layout: every card still sits in the one `gridX` sequence the three card
 * tables share (`dashboard-cards.ts`), and the grid flows in that order.
 * `gridW`/`gridH` are the card's column and row span; `gridY` is unused. A
 * coordinate layout would have to rewrite the sequence contract that mobile,
 * the PDF, config as code and the reorder route all read, for a gain (holes in
 * the grid) nobody asked for.
 */
import type { CostDateRange, DashboardWidgetKind } from "./costs";
import { costCanvasChangePercent, formatCostCanvasKpi } from "./cost-canvases";
import { SAVINGS_EVENT_KIND_LABELS, type SavingsEventKind } from "./realized-savings";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * KPI widget
 * ------------------------------------------------------------------ */

export const KPI_SOURCE_KINDS = [
  "cost_report",
  "budget",
  "commitments",
  "realized_savings",
] as const;
export type KpiSourceKind = (typeof KPI_SOURCE_KINDS)[number];

export const KPI_SOURCE_KIND_LABELS: Record<KpiSourceKind, string> = {
  cost_report: "Saved report",
  budget: "Budget",
  commitments: "Commitments",
  realized_savings: "Realized savings",
};

/**
 * What a report KPI counts. `cost`, `usage` and `count` are the report's own
 * measures; `unit_cost` and `business_metric` read the business metric the
 * report divides by (its unit cost), so they need a report with one attached.
 */
export const KPI_REPORT_MEASURES = [
  "cost",
  "usage",
  "count",
  "unit_cost",
  "business_metric",
] as const;
export type KpiReportMeasure = (typeof KPI_REPORT_MEASURES)[number];

export const KPI_REPORT_MEASURE_LABELS: Record<KpiReportMeasure, string> = {
  cost: "Spend",
  usage: "Usage",
  count: "Distinct count",
  unit_cost: "Unit cost",
  business_metric: "Business metric",
};

export const KPI_AGGREGATIONS = ["sum", "daily_average"] as const;
export type KpiAggregation = (typeof KPI_AGGREGATIONS)[number];

export const KPI_AGGREGATION_LABELS: Record<KpiAggregation, string> = {
  sum: "Total",
  daily_average: "Daily average",
};

/** A budget KPI follows the budget's own period, never a dashboard range. */
export const KPI_BUDGET_MEASURES = ["actual", "forecast", "remaining", "percent_used"] as const;
export type KpiBudgetMeasure = (typeof KPI_BUDGET_MEASURES)[number];

export const KPI_BUDGET_MEASURE_LABELS: Record<KpiBudgetMeasure, string> = {
  actual: "Spent this period",
  forecast: "Projected at period end",
  remaining: "Remaining",
  percent_used: "Percent used",
};

/**
 * Commitment KPIs. Coverage and utilization are read from the commitments
 * service over its own trailing window; savings are the realized savings the
 * org's commitments produced. There is no effective savings rate: nothing
 * stores the on-demand equivalent of covered usage, and a rate computed
 * against an approximation of it would be read as a purchasing signal.
 */
export const KPI_COMMITMENT_MEASURES = ["coverage", "utilization", "savings"] as const;
export type KpiCommitmentMeasure = (typeof KPI_COMMITMENT_MEASURES)[number];

export const KPI_COMMITMENT_MEASURE_LABELS: Record<KpiCommitmentMeasure, string> = {
  coverage: "Coverage",
  utilization: "Utilization",
  savings: "Savings",
};

export type KpiWidgetSource =
  | {
      kind: "cost_report";
      /** A saved report the reader can open; its filters, scope and basis apply. */
      reportId: string;
      measure: KpiReportMeasure;
      aggregation: KpiAggregation;
      /** For `usage` on a report that does not already measure one unit. */
      usageUnit?: string | undefined;
    }
  | { kind: "budget"; budgetId: string; measure: KpiBudgetMeasure }
  | { kind: "commitments"; measure: KpiCommitmentMeasure }
  | {
      kind: "realized_savings";
      /** Only savings of this kind; absent is every kind. */
      eventKind?: SavingsEventKind | undefined;
    };

/** A `kpi` dashboard widget. */
export interface KpiWidgetConfig {
  version: 1;
  source: KpiWidgetSource;
  /**
   * The window the number covers. Absent follows the source: a report's own
   * range, the last 30 days for savings. Ignored (and refused) where the
   * source has a window of its own (a budget's period, commitment coverage).
   */
  dateRange?: CostDateRange | undefined;
  /** Show the change against the same-length window before. */
  comparePreviousPeriod: boolean;
  /** Which direction the badge colours as good; absent derives it from the measure. */
  upIsGood?: boolean | undefined;
}

/** The window a source without one of its own reads when the card names none. */
export const KPI_DEFAULT_DATE_RANGE: CostDateRange = { kind: "relative", preset: "30d" };

export const DEFAULT_KPI_WIDGET_CONFIG: KpiWidgetConfig = {
  version: 1,
  source: { kind: "cost_report", reportId: "", measure: "cost", aggregation: "sum" },
  comparePreviousPeriod: true,
};

/** Whether the card's date range applies to this source at all. */
export function kpiSourceUsesDateRange(source: KpiWidgetSource): boolean {
  if (source.kind === "budget") return false;
  if (source.kind === "commitments") return source.measure === "savings";
  return true;
}

/** Whether "daily average" means anything for this source. */
export function kpiAggregationApplies(source: KpiWidgetSource): boolean {
  return (
    source.kind === "cost_report" &&
    (source.measure === "cost" ||
      source.measure === "usage" ||
      source.measure === "business_metric")
  );
}

/**
 * Whether a rise is good news, absent an explicit choice: spend, usage, unit
 * cost and a budget's consumption going up is bad; savings, coverage,
 * utilization, a budget's remaining headroom and a business metric (users,
 * requests, revenue) going up is good.
 */
export function defaultKpiUpIsGood(source: KpiWidgetSource): boolean {
  switch (source.kind) {
    case "cost_report":
      return source.measure === "business_metric";
    case "budget":
      return source.measure === "remaining";
    case "commitments":
    case "realized_savings":
      return true;
  }
}

export function kpiUpIsGood(config: Pick<KpiWidgetConfig, "source" | "upIsGood">): boolean {
  return config.upIsGood ?? defaultKpiUpIsGood(config.source);
}

/**
 * Why a config cannot be answered, or null. The structural half (ids present,
 * enums) is the zod schema's; this is the cross-field half, shared by the
 * schema, both editors and the evaluator.
 */
export function kpiWidgetConfigProblem(config: KpiWidgetConfig): string | null {
  const source = config.source;
  if (
    source.kind === "cost_report" &&
    source.aggregation === "daily_average" &&
    !kpiAggregationApplies(source)
  ) {
    return "A daily average only applies to spend, usage and business metric values.";
  }
  if (source.kind === "cost_report" && source.usageUnit && source.measure !== "usage") {
    return "A usage unit only applies to the usage measure.";
  }
  if (config.dateRange && !kpiSourceUsesDateRange(source)) {
    return source.kind === "budget"
      ? "A budget KPI follows the budget's own period, so it takes no date range."
      : "Commitment coverage and utilization are measured over their own trailing window, so they take no date range.";
  }
  return null;
}

/** How a KPI's figure is formatted. */
export type DashboardKpiUnit = "money" | "money_per_unit" | "percent" | "count" | "quantity";

/** POST /dashboards/kpi: the answer to one KPI question. */
export interface DashboardKpiResult {
  /** Null when there is no honest number (no data, no denominator). */
  value: number | null;
  unit: DashboardKpiUnit;
  /** ISO-4217 code for money units. */
  currency?: string | undefined;
  /** The denominator for `money_per_unit` ("active user"), the unit for `quantity`. */
  perUnit?: string | undefined;
  /** The same figure over the previous window; null when not compared or unknown. */
  previous: number | null;
  /** `value - previous`, or null. */
  change: number | null;
  /** Percent change, or null when the baseline makes it meaningless (zero, absent). */
  changePercent: number | null;
  /** The resolved direction the badge colours as good. */
  upIsGood: boolean;
  /** Inclusive window `value` covers. */
  from?: string | undefined;
  to?: string | undefined;
  /** Inclusive window `previous` covers. */
  previousFrom?: string | undefined;
  previousTo?: string | undefined;
  /** The report or budget the number came from, for the card's subtitle. */
  sourceName?: string | undefined;
  /** A budget's limit for the period, in the same unit as `value` (money or quantity). */
  limit?: number | null | undefined;
  /** A caveat worth printing under the number (mixed currencies, gaps). */
  note?: string | undefined;
}

/** `POST /dashboards/kpi` over a Bearer client (mobile, CLI). */
export async function fetchDashboardKpi(
  api: CloudFetch,
  orgId: string,
  config: KpiWidgetConfig,
): Promise<DashboardKpiResult | null> {
  return api.org<DashboardKpiResult>(orgId, "/dashboards/kpi", {
    method: "POST",
    body: JSON.stringify({ config }),
  });
}

/**
 * What the big number is, in English: "Spend, daily average", "Commitment
 * coverage". For the surfaces with no translation layer (mobile, the PDF,
 * the CLI); web and desktop build theirs from translated labels.
 */
export function kpiMeasureSummaryText(config: Pick<KpiWidgetConfig, "source">): string {
  const source = config.source;
  switch (source.kind) {
    case "cost_report": {
      const measure = KPI_REPORT_MEASURE_LABELS[source.measure];
      return source.aggregation === "daily_average" ? `${measure}, daily average` : measure;
    }
    case "budget":
      return KPI_BUDGET_MEASURE_LABELS[source.measure];
    case "commitments":
      return `Commitment ${KPI_COMMITMENT_MEASURE_LABELS[source.measure].toLowerCase()}`;
    case "realized_savings":
      return source.eventKind
        ? `Realized savings: ${SAVINGS_EVENT_KIND_LABELS[source.eventKind]}`
        : "Realized savings";
  }
}

/** Absolute and percent change; both null when either side is missing. */
export function kpiChange(
  value: number | null,
  previous: number | null | undefined,
): { change: number | null; changePercent: number | null } {
  if (value === null || previous === null || previous === undefined) {
    return { change: null, changePercent: null };
  }
  return { change: value - previous, changePercent: costCanvasChangePercent(value, previous) };
}

/** `good` / `bad` for a move in the badge's colour, `neutral` for none. */
export function kpiChangeTone(
  result: Pick<DashboardKpiResult, "change" | "upIsGood">,
): "good" | "bad" | "neutral" {
  if (result.change === null || result.change === 0 || !Number.isFinite(result.change)) {
    return "neutral";
  }
  return result.change > 0 === result.upIsGood ? "good" : "bad";
}

function formatQuantity(value: number, unit: string | undefined): string {
  const digits = Math.abs(value) < 10 && !Number.isInteger(value) ? 2 : 0;
  const out = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  return unit ? `${out} ${unit}` : out;
}

/** The big number, formatted for its unit. `-` when there is none. */
export function formatDashboardKpiValue(
  result: Pick<DashboardKpiResult, "value" | "unit" | "currency" | "perUnit">,
): string {
  if (result.value === null || !Number.isFinite(result.value)) return "-";
  if (result.unit === "quantity") return formatQuantity(result.value, result.perUnit);
  return formatCostCanvasKpi({
    value: result.value,
    unit: result.unit,
    currency: result.currency,
    perUnit: result.perUnit,
  });
}

/**
 * The absolute half of the badge, signed: `+$1,240`, `-3 pts`, `+12 GB`.
 * A percent figure moves in points, not percent of a percent.
 */
export function formatDashboardKpiChange(
  result: Pick<DashboardKpiResult, "change" | "unit" | "currency" | "perUnit">,
): string | null {
  const change = result.change;
  if (change === null || !Number.isFinite(change)) return null;
  const sign = change > 0 ? "+" : change < 0 ? "-" : "";
  const magnitude = Math.abs(change);
  if (result.unit === "percent") {
    return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(magnitude)} pts`;
  }
  // Re-use the value formatter on the magnitude, then put the sign in front:
  // Intl's own sign display differs between currencies and locales.
  const body =
    result.unit === "money_per_unit"
      ? formatDashboardKpiValue({ ...result, value: magnitude, perUnit: undefined })
      : formatDashboardKpiValue({ ...result, value: magnitude });
  return `${sign}${body}`;
}

/** The percent half of the badge: `+12.4%`, or null. */
export function formatDashboardKpiChangePercent(changePercent: number | null): string | null {
  if (changePercent === null || !Number.isFinite(changePercent)) return null;
  return `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(1)}%`;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive day count of a `YYYY-MM-DD` window. */
export function inclusiveDayCount(from: string, to: string): number {
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
  return Math.max(1, days + 1);
}

/** The same-length window immediately before `[from, to]`. */
export function previousEqualWindow(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = inclusiveDayCount(from, to);
  return { from: isoDay(start - days * DAY_MS), to: isoDay(start - DAY_MS) };
}

/* ------------------------------------------------------------------ *
 * Text widget
 * ------------------------------------------------------------------ */

export const TEXT_WIDGET_LIMITS = { maxLength: 20_000 } as const;

/** A `text` dashboard widget: markdown, stored as typed. */
export interface TextWidgetConfig {
  version: 1;
  markdown: string;
}

export const DEFAULT_TEXT_WIDGET_CONFIG: TextWidgetConfig = { version: 1, markdown: "" };

/**
 * Markdown as plain lines, for surfaces that cannot render it (the PDF, a
 * terminal). Headings, emphasis, code fences and link syntax are dropped;
 * a link keeps its URL after the text so a printed copy still says where it
 * pointed. Not a parser: good enough for prose, which is what this holds.
 */
export function markdownToPlainLines(markdown: string): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(paragraph.join(" "));
    paragraph = [];
  };
  let inFence = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (raw.trim()) out.push(raw.replace(/\s+$/, ""));
      continue;
    }
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flush();
      continue;
    }
    const inline = (s: string) =>
      s
        .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string) => (alt ? `[${alt}]` : ""))
        .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) =>
          text === url ? url : `${text} (${url})`,
        )
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(\*|_)(.+?)\1/g, "$2")
        .replace(/~~(.+?)~~/g, "$1");
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(inline(heading[1]!.replace(/\s+#+\s*$/, "")));
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /^\d+[.)]/.exec(line);
      out.push(`${ordered ? ordered[0] : "-"} ${inline(bullet[1]!)}`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    paragraph.push(inline(quote ? quote[1]! : line));
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * Grid layout
 * ------------------------------------------------------------------ */

/**
 * Bounds on a card's span. 12 matches what org config as code already
 * accepts for `width`/`height`; a span wider than the columns on screen is
 * drawn at the full row.
 */
export const DASHBOARD_GRID_LIMITS = { minSpan: 1, maxWidth: 12, maxHeight: 12 } as const;

/**
 * The grid's geometry, shared by both hosts so a span means the same thing
 * on web and desktop. Columns are `repeat(auto-fill, minmax(MIN_COLUMN, 1fr))`
 * and rows are `minmax(ROW, auto)`: a card is never shorter than its content,
 * so a height is a minimum, and a wide screen simply gets more columns.
 */
export const DASHBOARD_GRID_METRICS = { minColumnPx: 220, gapPx: 16, rowPx: 150 } as const;

export interface DashboardCardSize {
  w: number;
  h: number;
}

/**
 * The span a new widget of `kind` takes. Charts are double width, as they
 * have always been drawn; a budget, a KPI and a text card start single width.
 */
export function defaultWidgetSize(kind: DashboardWidgetKind): DashboardCardSize {
  switch (kind) {
    case "budget":
    case "kpi":
      return { w: 1, h: 1 };
    default:
      return { w: 2, h: 1 };
  }
}

/** Clamp a span to the stored bounds, and to `columns` when the grid is narrower. */
export function clampCardSize(size: DashboardCardSize, columns?: number): DashboardCardSize {
  const maxW = Math.max(
    DASHBOARD_GRID_LIMITS.minSpan,
    Math.min(DASHBOARD_GRID_LIMITS.maxWidth, columns ?? DASHBOARD_GRID_LIMITS.maxWidth),
  );
  const clamp = (v: number, max: number) =>
    Math.min(max, Math.max(DASHBOARD_GRID_LIMITS.minSpan, Math.round(Number.isFinite(v) ? v : 1)));
  return { w: clamp(size.w, maxW), h: clamp(size.h, DASHBOARD_GRID_LIMITS.maxHeight) };
}

/** How many columns an `auto-fill` grid of `containerWidth` pixels lays out. */
export function dashboardGridColumns(
  containerWidth: number,
  metrics: { minColumnPx: number; gapPx: number } = DASHBOARD_GRID_METRICS,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  return Math.max(
    1,
    Math.floor((containerWidth + metrics.gapPx) / (metrics.minColumnPx + metrics.gapPx)),
  );
}

/**
 * The span a resize drag lands on: the card's starting span plus however many
 * whole tracks the pointer moved, rounded to the nearest so the card snaps to
 * the closest column and row.
 */
export function snapCardResize(
  start: DashboardCardSize,
  delta: { x: number; y: number },
  grid: { columnWidth: number; rowHeight: number; gapPx: number; columns: number },
): DashboardCardSize {
  const colStep = Math.max(1, grid.columnWidth + grid.gapPx);
  const rowStep = Math.max(1, grid.rowHeight + grid.gapPx);
  return clampCardSize(
    { w: start.w + Math.round(delta.x / colStep), h: start.h + Math.round(delta.y / rowStep) },
    grid.columns,
  );
}

/**
 * The keyboard half of resizing: arrows grow and shrink the focused card one
 * track at a time. Null for any other key, so the caller leaves it alone.
 */
export function resizeCardByKey(
  size: DashboardCardSize,
  key: string,
  columns?: number,
): DashboardCardSize | null {
  const step: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowDown: [0, 1],
    ArrowUp: [0, -1],
  };
  const d = step[key];
  if (!d) return null;
  return clampCardSize({ w: size.w + d[0], h: size.h + d[1] }, columns);
}

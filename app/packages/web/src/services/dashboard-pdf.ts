/**
 * Dashboard and cost-report PDFs: turn every card into the document model in
 * `@infrawrench/server-core/pdf` and render it.
 *
 * Each card is answered by the same service its live card calls, so a PDF
 * can never disagree with the screen: cost graphs and saved reports through
 * `runCostQuery` (or `runUnitCostQuery` for a unit-cost card), budgets through
 * `getBudgetWithStatus`, custom graphs through `renderOrgCustomGraph` (the
 * sandbox run, whose chart spec already includes its KPI `stat` and `table`
 * forms), pinned resources and workflows from their rows. Amounts are
 * converted into the org's display currency when one is configured, exactly
 * like the digest and the scheduled report delivery.
 *
 * A card that fails renders its error in place rather than failing the
 * document: one broken saved filter must not cost the reader the other nine
 * cards. The same function backs the download routes and the scheduled
 * delivery loop (`dashboard-delivery-loop.ts`), which is why rendering lives
 * in the web app: these services are not in the poller's bundle.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  COST_BASIS_LABELS,
  COST_BINNING_LABELS,
  COST_DIMENSION_LABELS,
  COST_MEASURE_LABELS,
  COST_RANGE_PRESET_LABELS,
  FORECAST_COLOR,
  OTHER_GROUP_KEY,
  OTHER_SERIES_COLOR,
  SCENARIO_COLOR,
  costQueryForConfig,
  costSeriesTotal,
  effectiveCostBinning,
  isCostTotalsChart,
  describeCostConversion,
  orderDashboardCards,
  unitCostQueryForConfig,
  type BudgetWidgetConfig,
  type CostBinSize,
  type CostDimensionId,
  type CostGraphConfig,
  type CostQueryResponse,
  type CostReportWidgetConfig,
  type CustomGraphChart,
  type CustomGraphWidgetConfig,
  type CostCanvasWidgetConfig,
  type DashboardCardKind,
  type UnitCostQueryResponse,
} from "@infrawrench/client-core";
import {
  formatPdfValue,
  renderReportPdf,
  type PdfBlock,
  type PdfChartSeries,
  type PdfReportModel,
  type PdfSection,
  type PdfValueFormat,
} from "@infrawrench/server-core/pdf";
import { getOrgCurrencySettings } from "@infrawrench/server-core/cost/currency-settings";
import { orgAppUrl } from "@infrawrench/server-core/app-url";
import type {
  DashboardRenderRequest,
  RenderedDashboard,
} from "@infrawrench/server-core/report-delivery/dashboard";
import { db } from "../db/client";
import {
  accounts,
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  dashboards,
  organizations,
  resources,
  workflows,
} from "../db/schema";
import { getPlugin } from "../plugins/loader";
import { runCostQuery } from "./cost-query";
import { runUnitCostQuery } from "./unit-cost-query";
import { getBudgetWithStatus } from "./budgets";
import { getCostReport } from "./cost-reports";
import { renderOrgCustomGraph } from "./custom-graphs";

/** Options shared by both documents. */
export interface PdfRenderOptions {
  /**
   * Whether the reader may see cost data (`costs:read`). Cost and budget
   * cards are replaced by a note when false: a dashboard viewer without cost
   * access sees the same gap on screen, where those cards fail to load.
   */
  canReadCosts: boolean;
  /** IANA zone for the "generated" line; UTC when absent. */
  timezone?: string | undefined;
  now?: Date | undefined;
}

/** A section plus the one-line highlight a delivery message quotes. */
export interface CardRender {
  section: PdfSection;
  highlight: string | null;
}

const MAX_TABLE_ROWS = 50;
const COST_ACCESS_NOTE =
  "This card shows cost data, which your role does not include (costs:read).";

function rangeLabel(config: CostGraphConfig, from: string, to: string): string {
  return config.dateRange.kind === "relative"
    ? `${COST_RANGE_PRESET_LABELS[config.dateRange.preset]} (${from} to ${to})`
    : `${from} to ${to}`;
}

export function describeConfig(config: CostGraphConfig, from: string, to: string): string {
  const { bin, cumulative } = effectiveCostBinning(config);
  const parts = [rangeLabel(config, from, to), COST_BINNING_LABELS[bin].toLowerCase()];
  if (cumulative) parts.push("cumulative");
  if (config.measure === "usage") {
    parts.push(`usage${config.usageUnit ? ` in ${config.usageUnit}` : ""}`);
  } else if (config.measure === "count") {
    parts.push(COST_MEASURE_LABELS.count.toLowerCase());
  }
  if (config.groupBy !== "none") {
    parts.push(
      `by ${
        config.groupBy === "tag"
          ? `tag ${config.groupByTagKey ?? ""}`.trim()
          : COST_DIMENSION_LABELS[config.groupBy as CostDimensionId].toLowerCase()
      }`,
    );
  }
  if (config.costBasis) parts.push(`${COST_BASIS_LABELS[config.costBasis].toLowerCase()} basis`);
  if (config.adjusted) parts.push("billing rules applied");
  if (config.filters.length > 0 || config.savedFilterId) parts.push("filtered");
  return parts.join(" · ");
}

export function shortDate(bucket: string, bin: CostBinSize = "daily"): string {
  const d = new Date(`${bucket}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  if (bin === "quarterly") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (bin === "monthly") {
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function pctChange(current: number, previous: number): string {
  if (previous === 0) return "new";
  const pct = ((current - previous) / previous) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Map one cost query response onto blocks: the chart, then the totals. */
export function costResponseBlocks(
  config: CostGraphConfig,
  response: CostQueryResponse,
): { blocks: PdfBlock[]; total: string | null; totalChange: string | null } {
  const blocks: PdfBlock[] = [];
  const currencies = response.currencies;
  const primary = currencies[0];
  const { bin, cumulative } = effectiveCostBinning(config);
  // A quantity or a count has no currency: its series carry `""`, and the
  // values print as plain numbers (with the unit, for usage).
  const format: PdfValueFormat = response.measure
    ? response.usageUnit
      ? { unit: response.usageUnit }
      : {}
    : primary
      ? { currency: primary }
      : {};
  const valueFormat = (currency: string): PdfValueFormat =>
    response.measure ? format : { currency };
  const measureHeader =
    response.measure === "usage"
      ? `Usage${response.usageUnit ? ` (${response.usageUnit})` : ""}`
      : response.measure === "count"
        ? "Count"
        : "Spend";

  // Mixed currencies cannot share an axis: chart the primary one and list
  // every currency's total below, which is what the card itself says too.
  const series = response.series.filter((s) => !primary || s.currency === primary);
  const buckets = [
    ...new Set([
      ...series.flatMap((s) => s.points.map((p) => p.bucket)),
      ...(response.forecast ?? []).map((p) => p.bucket),
    ]),
  ].sort();

  const label = (key: string, l: string) => (key === OTHER_GROUP_KEY ? "Other" : l || "Total");

  if (isCostTotalsChart(config.chartType)) {
    blocks.push({
      kind: "pie",
      slices: series.map((s) => ({
        label: label(s.key, s.label),
        value: costSeriesTotal(s.points, cumulative),
        ...(s.key === OTHER_GROUP_KEY ? { color: OTHER_SERIES_COLOR } : {}),
      })),
      format,
    });
  } else if (config.chartType === "table") {
    // The table view: one row per bucket, a column per drawn series (capped so
    // the page stays readable) and the bucket total. The per-group totals
    // table below follows as on every other card.
    const shown = series.slice(0, 5);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const grid = shown.map((s) => {
      const values = new Array<number | null>(buckets.length).fill(null);
      for (const p of s.points) values[index.get(p.bucket) ?? 0] = p.amount;
      return values;
    });
    const tableRows = buckets.map((b, i) => {
      const cells = grid.map((values) => {
        const v = values[i];
        return v === null || v === undefined ? "-" : formatPdfValue(v, format);
      });
      const total = series.reduce(
        (sum, s) => sum + (s.points.find((p) => p.bucket === b)?.amount ?? 0),
        0,
      );
      return [shortDate(b, bin), ...cells, formatPdfValue(total, format)];
    });
    blocks.push({
      kind: "table",
      columns: ["Period", ...shown.map((s) => label(s.key, s.label)), "Total"],
      rows: tableRows.slice(-MAX_TABLE_ROWS),
      align: ["left", ...shown.map(() => "right" as const), "right"],
    });
  } else {
    const index = new Map(buckets.map((b, i) => [b, i]));
    const chartSeries: PdfChartSeries[] = series.map((s) => {
      const values = new Array<number | null>(buckets.length).fill(null);
      for (const p of s.points) values[index.get(p.bucket) ?? 0] = p.amount;
      return {
        label: label(s.key, s.label),
        values,
        ...(s.key === OTHER_GROUP_KEY ? { color: OTHER_SERIES_COLOR } : {}),
      };
    });
    if (response.forecast && response.forecast.length > 0) {
      const values = new Array<number | null>(buckets.length).fill(null);
      for (const p of response.forecast) values[index.get(p.bucket) ?? 0] = p.amount;
      chartSeries.push({
        label: "Forecast",
        values,
        color: FORECAST_COLOR,
        dashed: true,
        overlay: true,
      });
    }
    if (response.scenario && response.scenario.points.length > 0) {
      const values = new Array<number | null>(buckets.length).fill(null);
      for (const p of response.scenario.points) {
        const i = index.get(p.bucket);
        if (i !== undefined) values[i] = p.amount;
      }
      chartSeries.push({
        label: `Scenario: ${response.scenario.modelName}`,
        values,
        color: SCENARIO_COLOR,
        dashed: true,
        overlay: true,
      });
    }
    blocks.push({
      kind: "chart",
      chartType: config.chartType,
      categories: buckets.map((b) => shortDate(b, bin)),
      series: chartSeries,
      format,
    });
  }

  // Totals table: one row per series (the top groups), then the total.
  const rows: string[][] = series
    .map((s) => {
      const prevPoints = response.comparison?.find(
        (c) => c.key === s.key && c.currency === s.currency,
      )?.points;
      return {
        label: label(s.key, s.label),
        amount: costSeriesTotal(s.points, cumulative),
        prev: prevPoints ? costSeriesTotal(prevPoints, cumulative) : undefined,
        currency: s.currency,
      };
    })
    // A count series has one row, and its range total is a distinct count the
    // totals row below states; repeating it as a "group" would be noise.
    .filter(() => response.measure !== "count")
    .sort((a, b) => b.amount - a.amount)
    .map((r) => {
      const row = [r.label, formatPdfValue(r.amount, valueFormat(r.currency))];
      if (response.comparison) {
        row.push(r.prev === undefined ? "-" : formatPdfValue(r.prev, valueFormat(r.currency)));
        row.push(r.prev === undefined ? "-" : pctChange(r.amount, r.prev));
      }
      return row;
    });
  for (const currency of currencies) {
    const total = response.totals[currency] ?? 0;
    const prev = response.previousTotals?.[currency];
    const row = [
      currencies.length > 1 ? `Total (${currency})` : "Total",
      formatPdfValue(total, valueFormat(currency)),
    ];
    if (response.comparison) {
      row.push(prev === undefined ? "-" : formatPdfValue(prev, valueFormat(currency)));
      row.push(prev === undefined ? "-" : pctChange(total, prev));
    }
    rows.push(row);
  }
  if (rows.length > 0) {
    blocks.push({
      kind: "table",
      columns: response.comparison
        ? [
            config.groupBy === "none" ? "Series" : "Group",
            measureHeader,
            "Previous period",
            "Change",
          ]
        : [config.groupBy === "none" ? "Series" : "Group", measureHeader],
      rows: rows.slice(-MAX_TABLE_ROWS),
      align: ["left", "right", "right", "right"],
    });
  }

  const notes: string[] = [];
  if (response.conversion) {
    // Names the rate source and dates (stated rates and/or the ECB feed), the
    // same sentence the graph card prints, so a printed report can be checked.
    const note = describeCostConversion(response.conversion);
    if (note) notes.push(note);
  }
  if (response.adjustment) {
    notes.push(
      "Billing rules applied: these are adjusted figures, not what the providers charged.",
    );
  }
  if (response.measure === "count") {
    notes.push(
      "The total is the number of distinct values across the whole period, not the sum of the per-period counts.",
    );
  }
  if (currencies.length > 1) {
    notes.push(
      `Charted in ${primary}; spend in ${currencies.slice(1).join(", ")} is listed above.`,
    );
  }
  for (const note of notes) blocks.push({ kind: "text", text: note, tone: "muted" });

  const primaryTotal = primary !== undefined ? (response.totals[primary] ?? 0) : null;
  const prevTotal = primary !== undefined ? response.previousTotals?.[primary] : undefined;
  return {
    blocks,
    total:
      primary !== undefined && primaryTotal !== null
        ? formatPdfValue(primaryTotal, valueFormat(primary))
        : null,
    totalChange:
      primaryTotal !== null && prevTotal !== undefined ? pctChange(primaryTotal, prevTotal) : null,
  };
}

/** Map a unit-cost response onto blocks: the ratio line, then whole-period tiles. */
export function unitCostResponseBlocks(response: UnitCostQueryResponse): {
  blocks: PdfBlock[];
  unitLabel: string;
} {
  const buckets = [
    ...new Set(response.series.flatMap((s) => s.points.map((p) => p.bucket))),
  ].sort();
  const index = new Map(buckets.map((b, i) => [b, i]));
  const unitLabel =
    response.mode === "margin"
      ? "Margin"
      : `Cost per ${response.metric.unit || response.metric.name}`;
  const blocks: PdfBlock[] = [
    {
      kind: "chart",
      chartType: "line",
      categories: buckets.map((b) => shortDate(b)),
      series: response.series.map((s) => {
        const values = new Array<number | null>(buckets.length).fill(null);
        for (const p of s.points) values[index.get(p.bucket) ?? 0] = p.value;
        return { label: `${unitLabel} (${s.currency})`, values };
      }),
      format: response.series[0] ? { currency: response.series[0].currency } : {},
    },
    {
      kind: "stats",
      items: response.series.map((s) => ({
        label: `${unitLabel}, whole period`,
        value:
          s.overallValue === null ? "-" : formatPdfValue(s.overallValue, { currency: s.currency }),
        caption: `${formatPdfValue(s.overallCost, { currency: s.currency })} spend`,
      })),
    },
  ];
  return { blocks, unitLabel };
}

export async function costConfigCard(
  organizationId: string,
  title: string,
  config: CostGraphConfig,
  displayCurrency: string | null,
  now: Date,
): Promise<CardRender> {
  if (config.unitCostMetricId) {
    const request = unitCostQueryForConfig(config, now);
    const response = await runUnitCostQuery(organizationId, config.unitCostMetricId, {
      ...request,
      ...(displayCurrency ? { displayCurrency } : {}),
    });
    const { blocks, unitLabel } = unitCostResponseBlocks(response);
    const first = response.series[0];
    return {
      section: {
        title,
        subtitle: `${describeConfig(config, request.from, request.to)} · divided by ${response.metric.name}`,
        blocks,
      },
      highlight:
        first && first.overallValue !== null
          ? `${title}: ${formatPdfValue(first.overallValue, { currency: first.currency })} ${unitLabel.toLowerCase()}`
          : null,
    };
  }

  const request = costQueryForConfig(config, now);
  const response = await runCostQuery(organizationId, {
    ...request,
    ...(displayCurrency ? { displayCurrency } : {}),
  });
  const { blocks, total, totalChange } = costResponseBlocks(config, response);
  return {
    section: { title, subtitle: describeConfig(config, request.from, request.to), blocks },
    highlight: total
      ? `${title}: ${total}${totalChange ? ` (${totalChange} vs previous period)` : ""}, ${
          config.dateRange.kind === "relative"
            ? COST_RANGE_PRESET_LABELS[config.dateRange.preset].toLowerCase()
            : `${request.from} to ${request.to}`
        }`
      : null,
  };
}

export async function budgetCard(
  organizationId: string,
  title: string,
  config: BudgetWidgetConfig,
): Promise<CardRender> {
  const budget = await getBudgetWithStatus(organizationId, config.budgetId);
  if (!budget) {
    return {
      section: {
        title: title || "Budget",
        blocks: [{ kind: "text", text: "This budget was deleted.", tone: "muted" }],
      },
      highlight: null,
    };
  }
  const amount = budget.amountCents / 100;
  const actual = budget.actualCents / 100;
  const forecastCents = budget.scenarioForecastCents ?? budget.forecastCents;
  const forecast =
    forecastCents === null || forecastCents === undefined ? undefined : forecastCents / 100;
  const format = { currency: budget.currency };
  const fired = budget.currentMonthEvents.map((e) => `${e.thresholdType} ${e.thresholdPercent}%`);
  const captionParts = [
    forecast !== undefined
      ? `Forecast for ${budget.month}: ${formatPdfValue(forecast, format)}${forecast > amount ? `, over by ${formatPdfValue(forecast - amount, format)}` : ""}.`
      : null,
    budget.scenarioModelName ? `Forecast uses the scenario "${budget.scenarioModelName}".` : null,
    budget.useAdjustedSpend ? "Measured on billing-rule-adjusted spend." : null,
    fired.length > 0 ? `Thresholds crossed this month: ${fired.join(", ")}.` : null,
  ].filter((p): p is string => p !== null);
  return {
    section: {
      title: title || budget.name,
      subtitle: `Budget · ${budget.month}`,
      blocks: [
        {
          kind: "progress",
          label: budget.name,
          value: actual,
          max: amount,
          ...(forecast !== undefined ? { projected: forecast } : {}),
          markers: budget.thresholds.map((t) => ({
            at: (amount * t.percent) / 100,
            label: `${t.percent}%${t.type === "forecast" ? " fc" : ""}`,
          })),
          ...(captionParts.length > 0 ? { caption: captionParts.join(" ") } : {}),
          format,
        },
      ],
    },
    highlight: `${budget.name}: ${formatPdfValue(actual, format)} of ${formatPdfValue(amount, format)} (${amount > 0 ? Math.round((actual / amount) * 100) : 0}%)`,
  };
}

/** Map a custom graph's chart spec onto blocks. */
export function customChartBlocks(chart: CustomGraphChart): PdfBlock[] {
  switch (chart.type) {
    case "line":
    case "area":
    case "stacked_bar":
    case "multi_bar": {
      const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p.x)))];
      const allDates = xs.every((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x));
      const allNumbers = xs.every((x) => typeof x === "number");
      if (allDates || allNumbers) xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const index = new Map(xs.map((x, i) => [x, i]));
      return [
        {
          kind: "chart",
          chartType: chart.type,
          categories: xs.map((x) => (allDates ? shortDate(String(x).slice(0, 10)) : String(x))),
          series: chart.series.map((s) => {
            const values = new Array<number | null>(xs.length).fill(null);
            for (const p of s.points) values[index.get(p.x) ?? 0] = p.y;
            return { label: s.label ?? s.key, values, ...(s.color ? { color: s.color } : {}) };
          }),
          format: {
            ...(chart.yAxis?.currency ? { currency: chart.yAxis.currency } : {}),
            ...(chart.yAxis?.unit ? { unit: chart.yAxis.unit } : {}),
          },
        },
      ];
    }
    case "pie":
      return [
        {
          kind: "pie",
          slices: chart.slices.map((s) => ({
            label: s.label,
            value: s.value,
            ...(s.color ? { color: s.color } : {}),
          })),
          format: {
            ...(chart.currency ? { currency: chart.currency } : {}),
            ...(chart.unit ? { unit: chart.unit } : {}),
          },
        },
      ];
    case "stat":
      return [
        {
          kind: "stats",
          items: [
            {
              label: "Value",
              value:
                typeof chart.value === "number"
                  ? formatPdfValue(chart.value, {
                      ...(chart.currency ? { currency: chart.currency } : {}),
                      ...(chart.unit ? { unit: chart.unit } : {}),
                    })
                  : chart.value,
              ...(chart.caption ? { caption: chart.caption } : {}),
            },
          ],
        },
      ];
    case "table":
      return [
        {
          kind: "table",
          columns: chart.columns,
          rows: chart.rows
            .slice(0, MAX_TABLE_ROWS)
            .map((r) => r.map((cell) => (cell === null ? "" : String(cell)))),
          align: chart.columns.map((_, c) =>
            chart.rows.every((r) => r[c] === null || typeof r[c] === "number") ? "right" : "left",
          ),
        },
        ...(chart.rows.length > MAX_TABLE_ROWS
          ? [
              {
                kind: "text" as const,
                text: `Showing the first ${MAX_TABLE_ROWS} of ${chart.rows.length} rows.`,
                tone: "muted" as const,
              },
            ]
          : []),
      ];
  }
}

export async function customGraphCard(
  organizationId: string,
  title: string,
  config: CustomGraphWidgetConfig,
): Promise<CardRender> {
  const result = await renderOrgCustomGraph(organizationId, config.graphId, { trigger: "manual" });
  const name = title || result.spec?.title || "Custom graph";
  if (!result.ok || !result.spec) {
    return {
      section: {
        title: name,
        blocks: [
          {
            kind: "text",
            text: `The graph's script failed: ${result.error ?? "no output"}`,
            tone: "danger",
          },
        ],
      },
      highlight: null,
    };
  }
  const blocks = customChartBlocks(result.spec.chart);
  if (result.spec.notice) blocks.push({ kind: "text", text: result.spec.notice, tone: "muted" });
  const chart = result.spec.chart;
  const highlight =
    chart.type === "stat"
      ? `${name}: ${
          typeof chart.value === "number"
            ? formatPdfValue(chart.value, {
                ...(chart.currency ? { currency: chart.currency } : {}),
                ...(chart.unit ? { unit: chart.unit } : {}),
              })
            : chart.value
        }${chart.caption ? ` (${chart.caption})` : ""}`
      : null;
  return {
    section: {
      title: name,
      ...(result.spec.title && result.spec.title !== name ? { subtitle: result.spec.title } : {}),
      blocks,
    },
    highlight,
  };
}

export function failedCard(title: string, err: unknown): CardRender {
  const message = err instanceof Error ? err.message : String(err);
  return {
    section: {
      title: title || "Card",
      blocks: [
        { kind: "text", text: `This card could not be rendered: ${message}`, tone: "danger" },
      ],
    },
    highlight: null,
  };
}

export async function orgName(organizationId: string): Promise<string | undefined> {
  const [org] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return org?.displayName;
}

export async function displayCurrencyOf(organizationId: string): Promise<string | null> {
  return getOrgCurrencySettings(organizationId)
    .then((s) => s.displayCurrency)
    .catch(() => null);
}

/** Everything a dashboard document needs, before rendering. */
export async function buildDashboardModel(
  organizationId: string,
  dashboardId: string,
  opts: PdfRenderOptions,
): Promise<{ model: PdfReportModel; highlights: string[]; url: string | null } | null> {
  const now = opts.now ?? new Date();
  const [dashboard] = await db
    .select({ id: dashboards.id, name: dashboards.name })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (!dashboard) return null;

  const [widgets, pins, workflowPins, name, displayCurrency] = await Promise.all([
    db
      .select()
      .from(dashboardWidgets)
      .where(
        and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)),
      ),
    db
      .select({
        id: dashboardPins.id,
        gridX: dashboardPins.gridX,
        displayName: resources.displayName,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountName: accounts.displayName,
      })
      .from(dashboardPins)
      .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
      .leftJoin(accounts, eq(resources.accountId, accounts.id))
      .where(
        and(
          eq(dashboardPins.dashboardId, dashboardId),
          isNull(dashboardPins.deletedAt),
          isNull(resources.deletedAt),
        ),
      ),
    db
      .select({
        id: dashboardWorkflowPins.id,
        gridX: dashboardWorkflowPins.gridX,
        name: workflows.name,
        lastRunAt: workflows.lastRunAt,
      })
      .from(dashboardWorkflowPins)
      .innerJoin(workflows, eq(dashboardWorkflowPins.workflowId, workflows.id))
      .where(
        and(
          eq(dashboardWorkflowPins.dashboardId, dashboardId),
          isNull(dashboardWorkflowPins.deletedAt),
          isNull(workflows.deletedAt),
        ),
      ),
    orgName(organizationId),
    opts.canReadCosts ? displayCurrencyOf(organizationId) : Promise.resolve(null),
  ]);

  type Card = { kind: DashboardCardKind; id: string; gridX: number };
  const ordered = orderDashboardCards<Card>([
    ...pins.map((p) => ({ kind: "resource" as const, id: p.id, gridX: p.gridX })),
    ...workflowPins.map((p) => ({ kind: "workflow" as const, id: p.id, gridX: p.gridX })),
    ...widgets.map((w) => ({ kind: "widget" as const, id: w.id, gridX: w.gridX })),
  ]);

  // Resource and workflow pins are small cards on screen; on paper they read
  // best gathered into one table each, placed where the first of them sits.
  const sections: Array<Promise<CardRender>> = [];
  let resourcesPlaced = false;
  let workflowsPlaced = false;
  const widgetById = new Map(widgets.map((w) => [w.id, w]));

  for (const card of ordered) {
    if (card.kind === "resource") {
      if (resourcesPlaced) continue;
      resourcesPlaced = true;
      sections.push(resourceTable(pins));
    } else if (card.kind === "workflow") {
      if (workflowsPlaced) continue;
      workflowsPlaced = true;
      sections.push(
        Promise.resolve({
          section: {
            title: "Pinned workflows",
            blocks: [
              {
                kind: "table",
                columns: ["Workflow", "Last run"],
                rows: workflowPins.map((w) => [
                  w.name,
                  w.lastRunAt
                    ? w.lastRunAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"
                    : "Never",
                ]),
              },
            ],
          },
          highlight: null,
        }),
      );
    } else {
      const widget = widgetById.get(card.id);
      if (!widget) continue;
      sections.push(
        widgetCard(organizationId, widget, displayCurrency, opts.canReadCosts, now).catch((err) =>
          failedCard(widget.title, err),
        ),
      );
    }
  }

  const rendered = await Promise.all(sections);
  const url = orgAppUrl(organizationId, `dashboard/${dashboard.id}`);
  return {
    model: {
      title: dashboard.name,
      subtitle: `Dashboard · ${ordered.length} card${ordered.length === 1 ? "" : "s"}`,
      ...(name ? { orgName: name } : {}),
      url,
      ...(displayCurrency
        ? { notes: [`Amounts in ${displayCurrency} where the org's exchange rates allow.`] }
        : {}),
      sections: rendered.map((r) => r.section),
      generatedAt: now,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    },
    highlights: rendered.map((r) => r.highlight).filter((h): h is string => h !== null),
    url,
  };
}

async function resourceTable(
  pins: Array<{
    displayName: string;
    pluginId: string;
    resourceTypeId: string;
    accountName: string | null;
  }>,
): Promise<CardRender> {
  const rows = await Promise.all(
    pins.map(async (p) => {
      const plugin = await getPlugin(p.pluginId).catch(() => undefined);
      const manifest = plugin?.plugin.manifest;
      const type = plugin?.plugin.resourceTypes.find((t) => t.id === p.resourceTypeId);
      return [
        p.displayName,
        manifest?.displayName ?? p.pluginId,
        type?.displayName ?? p.resourceTypeId,
        p.accountName ?? "",
      ];
    }),
  );
  return {
    section: {
      title: "Pinned resources",
      blocks: [{ kind: "table", columns: ["Resource", "Provider", "Type", "Account"], rows }],
    },
    highlight: null,
  };
}

async function widgetCard(
  organizationId: string,
  widget: typeof dashboardWidgets.$inferSelect,
  displayCurrency: string | null,
  canReadCosts: boolean,
  now: Date,
): Promise<CardRender> {
  const costKind =
    widget.kind === "cost_graph" ||
    widget.kind === "cost_report" ||
    widget.kind === "budget" ||
    widget.kind === "cost_canvas";
  if (costKind && !canReadCosts) {
    return {
      section: {
        title: widget.title || "Cost card",
        blocks: [{ kind: "text", text: COST_ACCESS_NOTE, tone: "muted" }],
      },
      highlight: null,
    };
  }
  switch (widget.kind) {
    case "cost_graph":
      return costConfigCard(
        organizationId,
        widget.title || "Cost graph",
        widget.config as CostGraphConfig,
        displayCurrency,
        now,
      );
    case "cost_report": {
      const report = await getCostReport(
        organizationId,
        (widget.config as CostReportWidgetConfig).reportId,
      );
      if (!report) {
        return {
          section: {
            title: widget.title || "Saved report",
            blocks: [{ kind: "text", text: "This saved report was deleted.", tone: "muted" }],
          },
          highlight: null,
        };
      }
      const card = await costConfigCard(
        organizationId,
        widget.title || report.name,
        report.config,
        displayCurrency,
        now,
      );
      if (report.description) {
        card.section.blocks.unshift({ kind: "text", text: report.description, tone: "muted" });
      }
      return card;
    }
    case "budget":
      return budgetCard(organizationId, widget.title, widget.config as BudgetWidgetConfig);
    case "custom_graph":
      return customGraphCard(
        organizationId,
        widget.title,
        widget.config as CustomGraphWidgetConfig,
      );
    case "cost_canvas": {
      // A canvas is several sections on its own page; on a dashboard's paper
      // form its blocks are folded into one section under the canvas name.
      // Loaded lazily: cost-canvas-pdf imports this module's mappers, and the
      // canvas services pull in the database and visibility resolvers.
      const { canvasPdfSections } = await import("./cost-canvas-pdf");
      const built = await canvasPdfSections(
        organizationId,
        (widget.config as CostCanvasWidgetConfig).canvasId,
        { granted: null, now },
      );
      if (!built) {
        return {
          section: {
            title: widget.title || "Canvas",
            blocks: [{ kind: "text", text: "This canvas was deleted.", tone: "muted" }],
          },
          highlight: null,
        };
      }
      return {
        section: {
          title: widget.title || built.name,
          subtitle: "Canvas",
          blocks: built.sections.flatMap((sec) => [
            { kind: "text" as const, text: sec.title, tone: "muted" as const },
            ...sec.blocks,
          ]),
        },
        highlight: built.highlights[0] ?? null,
      };
    }
    default:
      return {
        section: {
          title: widget.title || widget.kind,
          blocks: [{ kind: "text", text: "This card type has no PDF form yet.", tone: "muted" }],
        },
        highlight: null,
      };
  }
}

/** Render a dashboard to PDF. Null when the dashboard does not exist. */
export async function renderDashboardPdf(
  organizationId: string,
  dashboardId: string,
  opts: PdfRenderOptions,
): Promise<{ name: string; pdf: Uint8Array } | null> {
  const built = await buildDashboardModel(organizationId, dashboardId, opts);
  if (!built) return null;
  return { name: built.model.title, pdf: renderReportPdf(built.model) };
}

/** Render one saved cost report to PDF. Null when the report does not exist. */
export async function renderCostReportPdf(
  organizationId: string,
  reportId: string,
  opts: Omit<PdfRenderOptions, "canReadCosts">,
): Promise<{ name: string; pdf: Uint8Array } | null> {
  const now = opts.now ?? new Date();
  const report = await getCostReport(organizationId, reportId);
  if (!report) return null;
  const [name, displayCurrency] = await Promise.all([
    orgName(organizationId),
    displayCurrencyOf(organizationId),
  ]);
  const card = await costConfigCard(
    organizationId,
    report.name,
    report.config,
    displayCurrency,
    now,
  );
  const model: PdfReportModel = {
    title: report.name,
    ...(report.description ? { subtitle: report.description } : {}),
    ...(name ? { orgName: name } : {}),
    url: orgAppUrl(organizationId, `cost-reports/${report.id}`),
    ...(report.placements.length > 0
      ? { notes: [`Shown on: ${report.placements.map((p) => p.dashboardName).join(", ")}.`] }
      : {}),
    sections: [{ ...card.section, title: "Spend" }],
    generatedAt: now,
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
  };
  return { name: report.name, pdf: renderReportPdf(model) };
}

/**
 * The {@link DashboardRenderer} the delivery loop and "Send now" use. A
 * schedule renders with full cost access: creating one is
 * `org:settings:write`, the step up that authorises shipping the org's spend.
 */
export async function renderDashboardForDelivery(
  req: DashboardRenderRequest,
): Promise<RenderedDashboard | null> {
  const built = await buildDashboardModel(req.organizationId, req.dashboardId, {
    canReadCosts: true,
    timezone: req.timezone,
    now: req.now,
  });
  if (!built) return null;
  return {
    name: built.model.title,
    pdf: req.includePdf ? renderReportPdf(built.model) : null,
    highlights: built.highlights,
    url: built.url,
  };
}

/**
 * The `query_costs` view: the period's total against the previous one, and
 * spend over time stacked by group (or ranked by value, for an X-axis
 * query). It can group the same query another way, by calling the tool again.
 */
import {
  CHART,
  h,
  legend,
  money,
  quantity,
  rankedBars,
  render,
  seriesColor,
  stackedBars,
} from "./draw";
import { resultJson, resultText, startView, type ToolResult } from "./runtime";

interface Point {
  bucket: string;
  amount: number;
}
interface Series {
  key: string;
  label: string;
  currency: string;
  points: Point[];
}
interface Response {
  series: Series[];
  currencies: string[];
  totals: Record<string, number>;
  previousTotals?: Record<string, number>;
  forecast?: Point[];
  measure?: "usage" | "count";
  usageUnit?: string;
  xAxis?: { values: Array<{ key: string; label: string }> };
  adjustment?: { rawTotals: Record<string, number> };
}

const GROUPINGS = [
  ["none", "Total"],
  ["provider", "Provider"],
  ["account", "Account"],
  ["service", "Service"],
  ["region", "Region"],
] as const;

const root = document.body;
let args: Record<string, unknown> = {};
let busy = false;

const view = startView("Infrawrench costs", {
  input(input) {
    args = input;
  },
  result: show,
});

function isResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "series" in value &&
    Array.isArray(value.series) &&
    "totals" in value
  );
}

function show(result: ToolResult): void {
  const data = resultJson(result);
  if (result.isError || !isResponse(data)) {
    render(root, h("div", { class: "error" }, resultText(result) || "No costs came back."));
    return;
  }
  // One currency drawn: the first, which is the display currency when converting.
  const currency = data.currencies[0] ?? "";
  const unit = data.measure === "usage" ? (data.usageUnit ?? "") : "";
  const fmt = (v: number, compact = false) =>
    data.measure ? quantity(v, unit) : money(v, currency, compact);
  const series = data.series.filter((s) => s.currency === currency);
  const total = data.totals[currency] ?? 0;
  const previous = data.previousTotals?.[currency];

  render(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row spread" },
        h("div", {}, h("h1", {}, title(data)), h("div", { class: "sub" }, period())),
        groupButtons(),
      ),
      h(
        "div",
        { class: "row" },
        h("span", { class: "big" }, fmt(total)),
        change(total, previous),
        data.adjustment
          ? h(
              "span",
              { class: "sub" },
              `adjusted; ${fmt(data.adjustment.rawTotals[currency] ?? 0)} as billed`,
            )
          : null,
      ),
      data.currencies.length > 1
        ? h(
            "div",
            { class: "sub" },
            `Also ${data.currencies
              .slice(1)
              .map((c) => money(data.totals[c] ?? 0, c))
              .join(", ")}, not drawn.`,
          )
        : null,
      data.xAxis ? byValue(data, series, fmt) : overTime(series, (v) => fmt(v, true)),
      data.forecast?.length
        ? h(
            "div",
            { class: "sub" },
            `Forecast to ${data.forecast.at(-1)?.bucket}: ${fmt(
              data.forecast.reduce((sum, p) => sum + p.amount, 0),
            )} more.`,
          )
        : null,
    ),
  );
}

function title(data: Response): string {
  if (data.measure === "count") return "Count";
  if (data.measure === "usage") return `Usage${data.usageUnit ? ` (${data.usageUnit})` : ""}`;
  return "Spend";
}

function period(): string {
  const from = typeof args.from === "string" ? args.from : null;
  const to = typeof args.to === "string" ? args.to : null;
  return from && to ? `${from} to ${to}` : "Last 30 days";
}

function change(total: number, previous: number | undefined): HTMLElement | null {
  if (previous === undefined || previous === 0) return null;
  const pct = ((total - previous) / Math.abs(previous)) * 100;
  return h(
    "span",
    { class: pct > 0 ? "up" : "down" },
    `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% on the previous period`,
  );
}

function overTime(series: Series[], fmt: (v: number) => string): HTMLElement {
  const buckets = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
  const stacks = series.map((s, rank) => {
    const byBucket = new Map(s.points.map((p) => [p.bucket, p.amount]));
    return {
      label: s.label || "Total",
      color: seriesColor(rank, s.key === CHART.otherKey),
      values: buckets.map((b) => byBucket.get(b) ?? 0),
    };
  });
  return h(
    "div",
    { class: "stack" },
    buckets.length
      ? stackedBars(buckets, stacks, fmt)
      : h("div", { class: "faint" }, "No spend in this period."),
    stacks.length > 1 ? legend(stacks) : null,
  );
}

function byValue(data: Response, series: Series[], fmt: (v: number) => string): HTMLElement {
  const values = data.xAxis?.values ?? [];
  const rows = values.map((v, rank) => ({
    label: v.label,
    value: series.reduce(
      (sum, s) =>
        sum + s.points.filter((p) => p.bucket === v.key).reduce((a, p) => a + p.amount, 0),
      0,
    ),
    color: seriesColor(rank, v.key === CHART.otherKey),
  }));
  return rankedBars(rows, fmt);
}

function groupButtons(): HTMLElement | null {
  // An X-axis query is already split by its axis; regrouping it means something else.
  if (typeof args.xAxis === "string") return null;
  const current = typeof args.groupBy === "string" ? args.groupBy : "none";
  return h(
    "div",
    { class: "row" },
    ...GROUPINGS.map(([groupBy, label]) =>
      h(
        "button",
        {
          "aria-pressed": groupBy === current ? "true" : "false",
          disabled: busy,
          onclick: () => void regroup(groupBy),
        },
        label,
      ),
    ),
  );
}

async function regroup(groupBy: string): Promise<void> {
  if (busy) return;
  busy = true;
  const next = { ...args, groupBy };
  try {
    const result = await view.callTool("query_costs", next);
    if (!result.isError) args = next;
    busy = false;
    show(result);
  } catch (err) {
    busy = false;
    render(root, h("div", { class: "error" }, err instanceof Error ? err.message : String(err)));
  }
}

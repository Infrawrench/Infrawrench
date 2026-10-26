/**
 * The `get_resource_metrics` view: one chart per series, with its latest
 * value and peak, and buttons to look over another window by calling the
 * tool again.
 */
import { h, lines, quantity, render, seriesColor } from "./draw";
import { resultJson, resultText, startView, type ToolResult } from "./runtime";

interface Series {
  label: string;
  unit?: string;
  points: Array<{ timestamp: number; value: number }>;
}

const WINDOWS = [
  ["1h", 3_600_000],
  ["24h", 86_400_000],
  ["7d", 7 * 86_400_000],
  ["30d", 30 * 86_400_000],
] as const;

const root = document.body;
let args: Record<string, unknown> = {};
let busy = false;

const view = startView("Infrawrench metrics", {
  input(input) {
    args = input;
  },
  result: show,
});

function seriesOf(value: unknown): Series[] | null {
  if (typeof value !== "object" || value === null || !("series" in value)) return null;
  return Array.isArray(value.series) ? value.series : null;
}

function show(result: ToolResult): void {
  const series = seriesOf(resultJson(result));
  if (result.isError || !series) {
    render(root, h("div", { class: "error" }, resultText(result) || "No metrics came back."));
    return;
  }
  const span = spanOf(series);
  render(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row spread" },
        h("h1", {}, "Metrics"),
        h(
          "div",
          { class: "row" },
          ...WINDOWS.map(([label, ms]) =>
            h(
              "button",
              {
                "aria-pressed": span !== null && Math.abs(span - ms) < ms * 0.2 ? "true" : "false",
                disabled: busy,
                onclick: () => void reload(ms),
              },
              label,
            ),
          ),
        ),
      ),
      series.length === 0
        ? h("div", { class: "faint" }, "This resource has no metrics for that window.")
        : h("div", { class: "cards" }, ...series.map(card)),
    ),
  );
}

function spanOf(series: Series[]): number | null {
  if (typeof args.startMs === "number" && typeof args.endMs === "number") {
    return args.endMs - args.startMs;
  }
  const times = series.flatMap((s) => s.points.map((p) => p.timestamp));
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : null;
}

function card(series: Series, rank: number): HTMLElement {
  const points = series.points.map((p) => ({ x: p.timestamp, y: p.value }));
  const latest = series.points.at(-1)?.value;
  const peak = Math.max(...series.points.map((p) => p.value));
  const span = points.length > 1 ? (points.at(-1)?.x ?? 0) - (points[0]?.x ?? 0) : 0;
  const time = (ms: number) =>
    new Date(ms).toLocaleString(
      undefined,
      span > 2 * 86_400_000
        ? { month: "short", day: "numeric" }
        : { hour: "2-digit", minute: "2-digit" },
    );
  return h(
    "div",
    { class: "card stack" },
    h(
      "div",
      { class: "row spread" },
      h("span", {}, series.label),
      latest === undefined ? null : h("strong", {}, quantity(latest, series.unit)),
    ),
    points.length
      ? lines(
          [{ label: series.label, color: seriesColor(rank), points }],
          time,
          (v) => quantity(v, series.unit),
          140,
          320,
        )
      : h("div", { class: "faint" }, "No points"),
    points.length ? h("div", { class: "sub" }, `Peak ${quantity(peak, series.unit)}`) : null,
  );
}

async function reload(ms: number): Promise<void> {
  if (busy) return;
  busy = true;
  const endMs = Date.now();
  const next = { ...args, startMs: endMs - ms, endMs };
  try {
    const result = await view.callTool("get_resource_metrics", next);
    if (!result.isError) args = next;
    busy = false;
    show(result);
  } catch (err) {
    busy = false;
    render(root, h("div", { class: "error" }, err instanceof Error ? err.message : String(err)));
  }
}

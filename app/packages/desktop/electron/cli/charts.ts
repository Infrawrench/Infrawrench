// Tiny terminal chart toolkit for the CLI's text + TUI modes. Everything is
// plain unicode + the shared color helpers — no chart library.
import { c, seriesColor, visibleWidth, formatNumber } from "./output";

const SPARK_TICKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** One-line sparkline, e.g. ▁▂▄█▆▃. Empty input renders dashes. */
export function sparkline(values: number[], width = values.length): string {
  if (values.length === 0) return "─".repeat(Math.max(1, width));
  const sampled = resample(values, width);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min || 1;
  return sampled.map((v) => SPARK_TICKS[Math.min(7, Math.floor(((v - min) / span) * 8))]!).join("");
}

/** Average-bucket resample of a series to a fixed number of points. */
export function resample(values: number[], buckets: number): number[] {
  if (buckets <= 0 || values.length === 0) return [];
  if (values.length <= buckets) return [...values];
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * values.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / buckets));
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j]!;
    out.push(sum / (end - start));
  }
  return out;
}

export interface LineChartOptions {
  width?: number;
  height?: number;
  unit?: string | undefined;
  colorIndex?: number;
}

/**
 * Multi-row braille-style area chart with a y-axis. Renders `height` rows of
 * `width` columns; each column is filled from the bottom with block glyphs
 * proportional to the value, which reads as a smooth filled curve.
 */
export function lineChart(values: number[], opts: LineChartOptions = {}): string[] {
  const width = Math.max(10, opts.width ?? 60);
  const height = Math.max(3, opts.height ?? 8);
  const color = seriesColor(opts.colorIndex ?? 0);

  if (values.length === 0) {
    return [c.dim("(no data points)")];
  }

  const sampled = resample(values, width);
  const min = Math.min(...sampled, 0);
  const max = Math.max(...sampled);
  const span = max - min || 1;

  const axisLabels = [max, min + span / 2, min].map((v) => formatNumber(v, opts.unit));
  const axisWidth = Math.max(...axisLabels.map((l) => l.length));

  // Each column gets a fill height in 1/8 cells across the full plot height.
  const eighths = sampled.map((v) => Math.round(((v - min) / span) * height * 8));

  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    const cellsFromTop = height - 1 - row; // rows render top→bottom
    let line = "";
    for (const h of eighths) {
      const cellFill = Math.min(8, Math.max(0, h - cellsFromTop * 8));
      line += cellFill === 0 ? " " : SPARK_TICKS[cellFill - 1]!;
    }
    let label = "";
    if (row === 0) label = axisLabels[0]!;
    else if (row === Math.floor((height - 1) / 2)) label = axisLabels[1]!;
    else if (row === height - 1) label = axisLabels[2]!;
    rows.push(`${c.dim(label.padStart(axisWidth))} ${c.dim("┤")}${color(line)}`);
  }
  rows.push(`${" ".repeat(axisWidth)} ${c.dim(`└${"─".repeat(width)}`)}`);
  return rows;
}

export interface BarChartItem {
  label: string;
  value: number;
  /** Preformatted value shown after the bar (falls back to formatNumber). */
  display?: string;
  colorIndex?: number;
}

/** Horizontal bar chart with aligned labels and values. */
export function barChart(items: BarChartItem[], width = 30): string[] {
  if (items.length === 0) return [c.dim("(none)")];
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  const labelWidth = Math.max(...items.map((i) => visibleWidth(i.label)));
  return items.map((item, idx) => {
    const color = seriesColor(item.colorIndex ?? idx);
    const filled = Math.round((Math.max(0, item.value) / max) * width);
    const bar = "█".repeat(filled) + c.dim("░".repeat(width - filled));
    const value = item.display ?? formatNumber(item.value);
    return `${item.label.padEnd(labelWidth)} ${color(bar)} ${value}`;
  });
}

/** Time-axis footer labels (start … end) sized to a chart width. */
export function timeAxis(fromMs: number, toMs: number, width: number, axisPad: number): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const sameDay = toMs - fromMs < 26 * 60 * 60 * 1000;
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const left = fmt(fromMs);
  const right = fmt(toMs);
  const gap = Math.max(1, width - left.length - right.length);
  return `${" ".repeat(axisPad)} ${c.dim(` ${left}${" ".repeat(gap)}${right}`)}`;
}

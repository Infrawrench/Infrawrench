import { useState } from "react";
import type { MetricChartNode } from "@infrawrench/plugin-base";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useLocale } from "gt-react";
import { createMetricTimeFormatter, createMetricValueFormatter } from "@infrawrench/client-core";
import { useChartTheme } from "../../chart-theme.js";
import { niceAxis, rowsExtent } from "./nice-axis.js";

/**
 * Minimum and maximum width of the Y-axis gutter. Humanized byte ticks
 * ("512.00 GiB") and word units ("750K tokens/s") need more room than the
 * default 50px; a plain "%"/count axis stays at the minimum. The ceiling only
 * stops a pathological unit string from squeezing the plot to nothing: it is
 * wide enough for any compact tick with a word unit, which a 90px cap was not.
 */
const MIN_AXIS_WIDTH = 50;
const MAX_AXIS_WIDTH = 160;
/** Rough width in px of one character at the axis tick font size (11px). */
const AXIS_CHAR_WIDTH = 6.5;
const AXIS_PADDING = 14;
/** Space kept between two X-axis labels, in px. */
const TIME_TICK_GAP = 24;
/** X-axis label budget before the chart has measured itself. */
const DEFAULT_TIME_TICKS = 6;

const COLORS = [
  "var(--color-chart-primary)",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#fb923c",
];

interface MetricChartProps {
  node: MetricChartNode;
}

export function MetricChart({ node }: MetricChartProps) {
  const chart = useChartTheme();
  const locale = useLocale();
  const [chartWidth, setChartWidth] = useState(0);

  if (node.series.length === 0) return null;

  // Merge all series into a single data array keyed by timestamp
  const tsMap = new Map<number, Record<string, number>>();
  for (const series of node.series) {
    for (const point of series.points) {
      const row = tsMap.get(point.timestamp) ?? { timestamp: point.timestamp };
      row[series.label] = point.value;
      tsMap.set(point.timestamp, row);
    }
  }
  const data = [...tsMap.values()].sort((a, b) => a["timestamp"]! - b["timestamp"]!);

  const unit = node.series[0]?.unit ?? "";

  // Zero-anchored y scale with nice steps: recharts' own ticks stretch the
  // domain below zero when the data max doesn't divide evenly.
  const extent = rowsExtent(data, { keys: node.series.map((s) => s.label) });
  const yScale = niceAxis(extent.min, extent.max);

  // One formatter per chart, scaled once from the axis extent: every tick,
  // the tooltip and the aria-label summary share it, so a byte-valued series
  // reads in a single consistent unit (e.g. all GiB) instead of each value
  // picking its own KiB/MiB/GiB independently.
  const axisMax = Math.max(Math.abs(yScale.domain[0]), Math.abs(yScale.domain[1]));
  const formatValue = createMetricValueFormatter(unit, axisMax, locale);
  // Ticks and tooltip read the span and spacing of the points: times of day
  // for a short window, dates for daily or weekly buckets.
  const formatTime = createMetricTimeFormatter(
    data.map((row) => row["timestamp"]!),
    locale,
  );

  // Widen the gutter for long formatted ticks (humanized bytes, word units
  // like "connections") instead of clipping them at a fixed 50px.
  const longestTick = yScale.ticks.reduce((max, t) => Math.max(max, formatValue(t).length), 0);
  const axisWidth = Math.min(
    MAX_AXIS_WIDTH,
    Math.max(MIN_AXIS_WIDTH, Math.ceil(longestTick * AXIS_CHAR_WIDTH + AXIS_PADDING)),
  );

  // As many evenly spaced time labels as the plot has room for, judged from
  // the widest label.
  const timeTicks = (() => {
    const labelChars = data.reduce(
      (max, row) => Math.max(max, formatTime.tick(row["timestamp"]!).length),
      0,
    );
    const plotWidth = chartWidth - axisWidth - 8;
    const budget =
      chartWidth > 0
        ? Math.max(2, Math.floor(plotWidth / (labelChars * AXIS_CHAR_WIDTH + TIME_TICK_GAP)))
        : DEFAULT_TIME_TICKS;
    return formatTime.ticks(budget);
  })();

  // Text alternative for the chart: metric name plus the latest value of
  // each series, read as a single image by assistive tech.
  const lastRow = data[data.length - 1];
  const latestSummary = lastRow
    ? node.series
        .map((series) =>
          lastRow[series.label] !== undefined
            ? `${series.label} ${formatValue(lastRow[series.label]!)}`
            : null,
        )
        .filter((part): part is string => part !== null)
        .join(", ")
    : "";
  const chartAriaLabel = `${node.title || "Metric"} chart${latestSummary ? `, latest: ${latestSummary}` : ""}`;

  return (
    <div className="w-full">
      {node.title && (
        <h3 className="text-sm font-medium text-on-surface-secondary mb-2">{node.title}</h3>
      )}
      <div className="h-64" role="img" aria-label={chartAriaLabel}>
        <ResponsiveContainer width="100%" height="100%" onResize={(width) => setChartWidth(width)}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts) => formatTime.tick(Number(ts))}
              tick={{ fill: chart.tick, fontSize: 11 }}
              // Evenly spaced points to label; recharts still drops any that
              // would overlap if the width estimate is off.
              ticks={timeTicks}
              stroke={chart.axis}
            />
            <YAxis
              // recharts wraps a tick at its spaces once it measures wider
              // than the gutter, and it measures at the page's font size, not
              // the tick's, so "4K requests" broke onto two lines. The gutter
              // is already sized to the labels: never wrap them.
              tick={{ fill: chart.tick, fontSize: 11, width: MAX_AXIS_WIDTH * 4 }}
              stroke={chart.axis}
              tickFormatter={formatValue}
              domain={yScale.domain}
              ticks={yScale.ticks}
              width={axisWidth}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chart.tooltipBg,
                border: `1px solid ${chart.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(ts) => formatTime.tooltip(Number(ts))}
              formatter={(value) => [formatValue(Number(value)), undefined]}
            />
            {node.series.map((series, i) => {
              const color = COLORS[i % COLORS.length];
              return (
                <Area
                  key={series.label}
                  type="monotone"
                  dataKey={series.label}
                  {...(color !== undefined ? { stroke: color, fill: color } : {})}
                  fillOpacity={0.1}
                  strokeWidth={1.5}
                  dot={false}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {node.timeRangeLabel && (
        <p className="text-xs text-on-surface-faint mt-1 text-right">{node.timeRangeLabel}</p>
      )}
    </div>
  );
}

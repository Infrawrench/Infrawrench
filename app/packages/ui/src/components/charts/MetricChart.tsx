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
import { useChartTheme } from "../../chart-theme.js";
import { niceAxis, rowsExtent } from "./nice-axis.js";

const COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"];

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

interface MetricChartProps {
  node: MetricChartNode;
}

export function MetricChart({ node }: MetricChartProps) {
  const chart = useChartTheme();

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

  // Zero-anchored y scale with nice steps — recharts' own ticks stretch the
  // domain below zero when the data max doesn't divide evenly.
  const extent = rowsExtent(data, { keys: node.series.map((s) => s.label) });
  const yScale = niceAxis(extent.min, extent.max);

  // Text alternative for the chart: metric name plus the latest value of
  // each series, read as a single image by assistive tech.
  const lastRow = data[data.length - 1];
  const latestSummary = lastRow
    ? node.series
        .map((series) =>
          lastRow[series.label] !== undefined
            ? `${series.label} ${lastRow[series.label]}${unit}`
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
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatTimestamp}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
            />
            <YAxis
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              tickFormatter={(v: number) => (unit ? `${v}${unit}` : String(v))}
              domain={yScale.domain}
              ticks={yScale.ticks}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chart.tooltipBg,
                border: `1px solid ${chart.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(ts) => new Date(Number(ts)).toLocaleTimeString()}
              formatter={(value) => [`${value}${unit}`, undefined]}
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

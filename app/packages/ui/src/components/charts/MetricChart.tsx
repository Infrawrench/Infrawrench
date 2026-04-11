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

const COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"];

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

interface MetricChartProps {
  node: MetricChartNode;
}

export function MetricChart({ node }: MetricChartProps) {
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

  return (
    <div className="w-full">
      {node.title && <h3 className="text-sm font-medium text-gray-300 mb-2">{node.title}</h3>}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatTimestamp}
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              stroke="#4b5563"
            />
            <YAxis
              tick={{ fill: "#9ca3af", fontSize: 11 }}
              stroke="#4b5563"
              tickFormatter={(v: number) => (unit ? `${v}${unit}` : String(v))}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(ts) => new Date(Number(ts)).toLocaleTimeString()}
              formatter={(value) => [`${value}${unit}`, undefined]}
            />
            {node.series.map((series, i) => (
              <Area
                key={series.label}
                type="monotone"
                dataKey={series.label}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.1}
                strokeWidth={1.5}
                dot={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {node.timeRangeLabel && (
        <p className="text-xs text-gray-600 mt-1 text-right">{node.timeRangeLabel}</p>
      )}
    </div>
  );
}

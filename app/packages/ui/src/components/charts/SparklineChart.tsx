import type { MetricSeriesPoint } from "@infrawrench/plugin-base";
import { AreaChart, Area, ResponsiveContainer } from "recharts";

interface SparklineChartProps {
  points: MetricSeriesPoint[];
  color?: string;
  width?: number;
  height?: number;
}

export function SparklineChart({
  points,
  color = "#60a5fa",
  width = 80,
  height = 30,
}: SparklineChartProps) {
  if (points.length < 2) return null;

  const data = points
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((p) => ({ t: p.timestamp, v: p.value }));

  return (
    <div style={{ width, height, outline: "none" }} tabIndex={-1}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
            strokeWidth={1}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

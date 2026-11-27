import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGT } from "gt-react";
import {
  RUNWAY_HORIZON_DAYS,
  formatRunwayAmount,
  type ResourceRunwayRow,
} from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { niceAxis } from "../components/charts/nice-axis.js";

const DAY_MS = 86_400_000;

/** Where the projection line ends: the crossing, the cycle's end, or a window's worth ahead. */
function projectionEnd(row: ResourceRunwayRow, nowMs: number, spanMs: number): number | null {
  if (row.forecast.perDay === null || row.status === "full") return null;
  if (row.kind === "allowance" && row.cycle) return Date.parse(row.cycle.end);
  if (row.forecast.fullAt) return Date.parse(row.forecast.fullAt);
  if (row.forecast.perDay <= 0) return null;
  // Rising but past the horizon: draw as far ahead as the history reaches back,
  // which shows the direction without implying a date.
  return nowMs + Math.min(Math.max(spanMs, 7 * DAY_MS), RUNWAY_HORIZON_DAYS * DAY_MS);
}

interface ChartRow {
  t: number;
  used?: number;
  projected?: number;
}

/**
 * One usage's runway: the recorded readings, the limit as a line, and the
 * projection dashed from the current reading to where it meets the limit (or,
 * for a monthly allowance, to the end of the cycle).
 */
export function RunwayChart({ row, now = Date.now() }: { row: ResourceRunwayRow; now?: number }) {
  const gt = useGT();
  const chart = useChartTheme();

  const history = row.history
    .map((p) => ({ t: Date.parse(p.observedAt), used: p.used }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const firstT = history[0]?.t ?? now;
  const end = projectionEnd(row, now, now - firstT);

  const data: ChartRow[] = history.map((p) => ({ t: p.t, used: p.used }));
  data.push({ t: now, used: row.used, projected: row.used });
  if (end !== null && end > now && row.forecast.perDay !== null) {
    const days = (end - now) / DAY_MS;
    data.push({ t: end, projected: row.used + row.forecast.perDay * days });
  }

  const values = data
    .flatMap((d) => [d.used, d.projected])
    .filter((v): v is number => v !== undefined);
  const yScale = niceAxis(0, Math.max(row.limit * 1.05, ...values));
  const format = (v: number) => formatRunwayAmount(v, row.unit);
  const formatDate = (t: number) => new Date(t).toLocaleDateString();

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium text-on-surface-secondary">{row.label}</h3>
        <span className="text-xs text-on-surface-faint tabular-nums">
          {gt("{used} of {limit}", { used: format(row.used), limit: format(row.limit) })}
        </span>
      </div>
      <div
        className="h-56"
        role="img"
        aria-label={gt("{label} runway chart: {used} of {limit}", {
          label: row.label,
          used: format(row.used),
          limit: format(row.limit),
        })}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatDate}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              tickFormatter={format}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              width={80}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chart.tooltipBg,
                border: `1px solid ${chart.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
              formatter={(value) => [format(Number(value)), undefined]}
            />
            <ReferenceLine
              y={row.limit}
              stroke="var(--color-danger, #ef4444)"
              strokeDasharray="4 4"
              label={{
                value: gt("Limit"),
                position: "insideTopRight",
                fill: chart.tick,
                fontSize: 11,
              }}
            />
            {row.cycle && (
              <ReferenceLine
                x={Date.parse(row.cycle.end)}
                stroke={chart.axis}
                strokeDasharray="2 4"
              />
            )}
            <Line
              type="monotone"
              dataKey="used"
              name={gt("Used")}
              stroke={chart.colors[0] ?? "currentColor"}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="linear"
              dataKey="projected"
              name={gt("Runway")}
              stroke={chart.colors[2] ?? chart.colors[0] ?? "currentColor"}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

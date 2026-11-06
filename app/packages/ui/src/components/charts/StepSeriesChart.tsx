import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLocale } from "gt-react";
import { useChartTheme } from "../../chart-theme.js";
import { niceAxis } from "./nice-axis.js";

export interface StepSeries {
  id: string;
  label: string;
  /** `[unix seconds, value]`, oldest first; `null` means no value from then on. */
  points: readonly (readonly [number, number | null])[];
}

interface StepSeriesChartProps {
  series: readonly StepSeries[];
  /** Unix seconds the last values run to. */
  end: number;
  format: (value: number) => string;
  /** What the chart shows, for screen readers. */
  label: string;
  /** Start the y axis at zero, for counts. */
  fromZero?: boolean;
  height?: number;
}

const TICKS = 6;
const SHORT_SPAN_MS = 180 * 86_400_000;

/** The value of a step series at `t`: its newest point at or before `t`. */
function valueAt(points: StepSeries["points"], t: number): number | null {
  let out: number | null = null;
  for (const [at, value] of points) {
    if (at > t) break;
    out = value;
  }
  return out;
}

/** Values that hold until they change, such as prices: stepped lines over time. */
export function StepSeriesChart({
  series,
  end,
  format,
  label,
  fromZero = false,
  height = 240,
}: StepSeriesChartProps) {
  const chart = useChartTheme();
  const locale = useLocale();
  const plotted = useMemo(() => series.filter((s) => s.points.length > 0), [series]);
  const data = useMemo(() => {
    const moments = new Set<number>();
    for (const s of plotted) for (const [at] of s.points) moments.add(at);
    if (moments.size > 0) moments.add(Math.max(end, ...moments));
    return [...moments]
      .sort((a, b) => a - b)
      .map((t) => {
        const row: Record<string, number | null> = { t: t * 1000 };
        for (const s of plotted) row[s.id] = valueAt(s.points, t);
        return row;
      });
  }, [plotted, end]);

  if (data.length === 0) return null;

  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const first = data[0]!["t"]!;
  const span = data[data.length - 1]!["t"]! - first;
  // Recharts would only label the points it has, and a price that rarely changes
  // has two. A few weeks of history (a new source) needs days rather than months.
  const tick = new Intl.DateTimeFormat(
    locale,
    span < SHORT_SPAN_MS
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", year: "2-digit", timeZone: "UTC" },
  );
  const ticks = Array.from(
    { length: TICKS },
    (_, i) => first + Math.round((span * i) / (TICKS - 1)),
  );
  // A price that never changed has no range: Recharts' automatic domain then runs
  // below zero around it. Anchor that case at zero and let the rest zoom in.
  const values = plotted.flatMap((s) =>
    s.points.flatMap(([, value]) => (value === null ? [] : [value])),
  );
  const flat = values.length > 0 && Math.min(...values) === Math.max(...values);
  const flatAxis = flat ? niceAxis(0, values[0]!) : null;
  const color = (i: number) => chart.colors[i % chart.colors.length];

  return (
    <div>
      <div style={{ height }} role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              ticks={ticks}
              tickFormatter={(t) => tick.format(Number(t))}
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: chart.tick, fontSize: 11 }}
              stroke={chart.axis}
              tickFormatter={(v) => format(Number(v))}
              domain={flatAxis?.domain ?? (fromZero ? [0, "auto"] : ["auto", "auto"])}
              {...(flatAxis ? { ticks: flatAxis.ticks } : {})}
              width={72}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chart.tooltipBg,
                border: `1px solid ${chart.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(t) => day.format(Number(t))}
              formatter={(value, name) => [
                format(Number(value)),
                plotted.find((s) => s.id === name)?.label ?? String(name),
              ]}
            />
            {plotted.map((s, i) => {
              const stroke = color(i);
              return (
                <Line
                  key={s.id}
                  dataKey={s.id}
                  type="stepAfter"
                  {...(stroke !== undefined ? { stroke } : {})}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {plotted.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-muted">
          {plotted.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3"
                style={{ backgroundColor: color(i) }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

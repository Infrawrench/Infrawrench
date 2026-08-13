import { G, Line as SvgLine, Rect, Text as SvgText } from "react-native-svg";
import { colors } from "@/lib/theme";

/**
 * The geometry and marks the mobile SVG charts share.
 *
 * CostChart and CustomGraphChart both draw into the same 320x168 viewBox with
 * the same padding, gridline treatment, and grouped/stacked bar mark — web and
 * desktop hand the same series to recharts, which is DOM-only, so mobile draws
 * them itself. What differs between the two charts (line gap handling, area
 * fills, legends, overlays) stays in each chart; the shared pieces live here so
 * a bar on the cost card and a bar on a custom graph land on the same grid.
 */

/** The app-wide categorical order (web `chart-theme.ts`), assigned per series. */
export const SERIES_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"];

export const CHART_WIDTH = 320;
export const CHART_HEIGHT = 168;
export const PAD = { top: 8, right: 6, bottom: 18, left: 46 };
export const PLOT_W = CHART_WIDTH - PAD.left - PAD.right;
export const PLOT_H = CHART_HEIGHT - PAD.top - PAD.bottom;
/** Surface-colored gap between adjacent marks, in viewBox units. */
export const MARK_GAP = 2;

/** What the shared marks need of a series; each chart's own type carries more. */
export interface BarSeries {
  label: string;
  color: string;
  /** Value per bucket index; a missing bucket draws as 0 on bars. */
  values: Array<number | null>;
}

/** Recessive horizontal gridlines carrying the y-axis tick labels. */
export function GridTicks({
  ticks,
  y,
  format,
}: {
  ticks: number[];
  y: (value: number) => number;
  format: (value: number) => string;
}) {
  return (
    <>
      {ticks.map((t) => (
        <G key={t}>
          <SvgLine
            x1={PAD.left}
            y1={y(t)}
            x2={CHART_WIDTH - PAD.right}
            y2={y(t)}
            stroke={colors.border}
            strokeWidth={1}
          />
          <SvgText
            x={PAD.left - 4}
            y={y(t) + 3}
            fill={colors.textFaint}
            fontSize={8}
            textAnchor="end"
          >
            {format(t)}
          </SvgText>
        </G>
      ))}
    </>
  );
}

/**
 * First and last bucket labels only — interior labels collide at this width.
 */
export function EdgeLabels({ start, end }: { start: string; end?: string | null }) {
  return (
    <>
      <SvgText x={PAD.left} y={CHART_HEIGHT - 5} fill={colors.textFaint} fontSize={8}>
        {start}
      </SvgText>
      {end != null && (
        <SvgText
          x={CHART_WIDTH - PAD.right}
          y={CHART_HEIGHT - 5}
          fill={colors.textFaint}
          fontSize={8}
          textAnchor="end"
        >
          {end}
        </SvgText>
      )}
    </>
  );
}

/** Grouped or stacked bars, one group per bucket. */
export function Bars({
  series,
  bucketCount,
  stacked,
  band,
  y,
}: {
  series: BarSeries[];
  bucketCount: number;
  stacked: boolean;
  band: number;
  y: (value: number) => number;
}) {
  const zero = y(0);
  const groupWidth = Math.max(2, band - MARK_GAP * 2);
  const barWidth = stacked ? groupWidth : Math.max(1.5, groupWidth / series.length - MARK_GAP / 2);

  return (
    <G>
      {Array.from({ length: bucketCount }, (_, i) => {
        let stackTop = 0;
        return (
          <G key={i}>
            {series.map((s, si) => {
              const value = s.values[i] ?? 0;
              if (value === 0) return null;
              const left = PAD.left + band * i + (band - groupWidth) / 2;
              const x = stacked ? left : left + si * (barWidth + MARK_GAP / 2);
              const top = stacked ? y(stackTop + value) : y(value);
              const bottom = stacked ? y(stackTop) : zero;
              if (stacked) stackTop += value;
              const height = Math.abs(bottom - top);
              if (height <= 0) return null;
              return (
                <Rect
                  key={s.label}
                  x={x}
                  y={Math.min(top, bottom)}
                  width={barWidth}
                  // A surface gap keeps stacked segments legible; a segment
                  // thinner than the gap still has to draw something.
                  height={stacked ? Math.max(0.5, height - MARK_GAP) : height}
                  fill={s.color}
                  rx={stacked ? 0 : 2}
                />
              );
            })}
          </G>
        );
      })}
    </G>
  );
}

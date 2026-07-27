import { StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  G,
  Line as SvgLine,
  Path,
  Polyline,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import {
  binForecast,
  formatBucketLabel,
  formatMoney,
  niceAxis,
  totalPerBucket,
  OTHER_GROUP_KEY,
  type CostBinningId,
  type CostChartType,
  type CostQueryResponse,
} from "@infrawrench/client-core";
import { colors, spacing } from "@/lib/theme";

/**
 * The cost chart, drawn with `react-native-svg`.
 *
 * Web and desktop hand these series to recharts, which is a DOM library, so
 * mobile draws the same five chart types itself. The binning, axis, and
 * formatting maths come from `@infrawrench/client-core`, so a bar on the phone
 * lands on the same tick as the one on the dashboard it was configured on.
 *
 * Phones have no hover, so the tooltip layer the web card leans on is replaced
 * by a legend carrying each series' period total: identity and value stay
 * readable without a pointer, which is also what keeps the two closest hues in
 * our categorical order tellable apart.
 */

/** The app-wide categorical order (web `chart-theme.ts`), assigned per entity. */
const SERIES_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"];
/** "Other" is always neutral — never a categorical hue. */
const OTHER_COLOR = "#6b7280";
/** The forecast overlay reads as the same measure, so it wears series one. */
const FORECAST_COLOR = SERIES_COLORS[0]!;

const WIDTH = 320;
const HEIGHT = 168;
const PAD = { top: 8, right: 6, bottom: 18, left: 46 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
/** Surface-colored gap between adjacent marks, in viewBox units. */
const MARK_GAP = 2;

export interface CostChartProps {
  response: CostQueryResponse;
  chartType: CostChartType;
  binning: CostBinningId;
  currency: string;
}

interface PlotSeries {
  label: string;
  color: string;
  total: number;
  /** Amount per bucket index; 0 where the series has no point. */
  values: number[];
}

function colorFor(index: number, isOther: boolean): string {
  return isOther ? OTHER_COLOR : (SERIES_COLORS[index % SERIES_COLORS.length] ?? OTHER_COLOR);
}

export function CostChart({ response, chartType, binning, currency }: CostChartProps) {
  const actualTotals = totalPerBucket(response.series);

  // Forecast buckets run past the observed ones, so they widen the axis.
  const forecastPoints = response.forecast
    ? binForecast(
        response.forecast,
        binning,
        binning === "cumulative" ? actualTotals[actualTotals.length - 1]?.amount : undefined,
      )
    : [];

  const buckets = [
    ...new Set([...actualTotals.map((p) => p.bucket), ...forecastPoints.map((p) => p.bucket)]),
  ].sort();
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const series: PlotSeries[] = response.series.map((s, i) => {
    const values = new Array<number>(buckets.length).fill(0);
    for (const p of s.points) values[bucketIndex.get(p.bucket)!] = p.amount;
    return {
      label: s.label,
      color: colorFor(i, s.key === OTHER_GROUP_KEY),
      total: s.points.reduce((sum, p) => sum + p.amount, 0),
      values,
    };
  });

  if (buckets.length === 0 || series.length === 0) {
    return <Text style={styles.empty}>No cost data for this period yet</Text>;
  }

  if (chartType === "pie") return <PieChart series={series} currency={currency} />;

  const stacked = chartType === "stacked_bar" || chartType === "area";

  // The previous period lands positionally — bucket #n onto bucket #n — the
  // same overlay rule the web card uses.
  const previousTotals = response.comparison ? totalPerBucket(response.comparison) : null;
  const comparison = previousTotals
    ? buckets.map((_, i) => previousTotals[i]?.amount ?? null)
    : null;

  // The forecast line starts at the last observed total so it connects.
  const forecast =
    forecastPoints.length > 0 ? new Array<number | null>(buckets.length).fill(null) : null;
  if (forecast) {
    const lastActual = actualTotals[actualTotals.length - 1];
    if (lastActual) forecast[bucketIndex.get(lastActual.bucket)!] = lastActual.amount;
    for (const p of forecastPoints) {
      const at = bucketIndex.get(p.bucket)!;
      forecast[at] = (forecast[at] ?? 0) + p.amount;
    }
  }

  const stackTotals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const plotted = [
    ...(stacked ? stackTotals : series.flatMap((s) => s.values)),
    ...(comparison ?? []),
    ...(forecast ?? []),
  ].filter((v): v is number => v !== null);
  const axis = niceAxis(Math.min(0, ...plotted), Math.max(0, ...plotted), 4);
  const [lo, hi] = axis.domain;

  const y = (value: number) => PAD.top + PLOT_H - ((value - lo) / (hi - lo || 1)) * PLOT_H;
  const bandWidth = PLOT_W / buckets.length;
  /** Center of bucket i — where lines, areas, and bar groups anchor. */
  const cx = (i: number) => PAD.left + bandWidth * (i + 0.5);
  const polyline = (values: Array<number | null>): string =>
    values
      .map((v, i) => (v === null ? null : `${cx(i)},${y(v)}`))
      .filter((p): p is string => p !== null)
      .join(" ");

  return (
    <View style={{ gap: spacing.sm }}>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {/* Recessive gridlines carrying the tick labels. */}
        {axis.ticks.map((t) => (
          <G key={t}>
            <SvgLine
              x1={PAD.left}
              y1={y(t)}
              x2={WIDTH - PAD.right}
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
              {formatMoney(t, currency)}
            </SvgText>
          </G>
        ))}

        {chartType === "stacked_bar" || chartType === "multi_bar" ? (
          <Bars
            series={series}
            bucketCount={buckets.length}
            stacked={stacked}
            band={bandWidth}
            y={y}
          />
        ) : chartType === "area" ? (
          <Areas series={series} cx={cx} y={y} />
        ) : (
          <Lines series={series} cx={cx} y={y} polyline={polyline} />
        )}

        {comparison && (
          <Polyline
            points={polyline(comparison)}
            fill="none"
            stroke={colors.textMuted}
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        )}
        {forecast && (
          <Polyline
            points={polyline(forecast)}
            fill="none"
            stroke={FORECAST_COLOR}
            strokeWidth={2}
            strokeDasharray="5 5"
          />
        )}

        {/* First and last bucket only — interior labels collide at this width. */}
        <SvgText x={PAD.left} y={HEIGHT - 5} fill={colors.textFaint} fontSize={8}>
          {formatBucketLabel(buckets[0]!, binning)}
        </SvgText>
        {buckets.length > 1 && (
          <SvgText
            x={WIDTH - PAD.right}
            y={HEIGHT - 5}
            fill={colors.textFaint}
            fontSize={8}
            textAnchor="end"
          >
            {formatBucketLabel(buckets[buckets.length - 1]!, binning)}
          </SvgText>
        )}
      </Svg>

      <Legend
        series={series}
        currency={currency}
        extra={[
          ...(comparison ? [{ label: "Previous period", color: colors.textMuted }] : []),
          ...(forecast ? [{ label: "Forecast", color: FORECAST_COLOR }] : []),
        ]}
      />
    </View>
  );
}

function Bars({
  series,
  bucketCount,
  stacked,
  band,
  y,
}: {
  series: PlotSeries[];
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

/** Stacked areas: each series is drawn over the running total beneath it. */
function Areas({
  series,
  cx,
  y,
}: {
  series: PlotSeries[];
  cx: (i: number) => number;
  y: (value: number) => number;
}) {
  const running = new Array<number>(series[0]?.values.length ?? 0).fill(0);
  return (
    <G>
      {series.map((s) => {
        const below = [...running];
        s.values.forEach((v, i) => {
          running[i] = (running[i] ?? 0) + v;
        });
        const top = running.map((v, i) => `${cx(i)},${y(v)}`);
        const bottom = below.map((v, i) => `${cx(i)},${y(v)}`).reverse();
        return (
          <G key={s.label}>
            <Path d={`M${top.join("L")}L${bottom.join("L")}Z`} fill={s.color} fillOpacity={0.15} />
            <Polyline points={top.join(" ")} fill="none" stroke={s.color} strokeWidth={2} />
          </G>
        );
      })}
    </G>
  );
}

function Lines({
  series,
  cx,
  y,
  polyline,
}: {
  series: PlotSeries[];
  cx: (i: number) => number;
  y: (value: number) => number;
  polyline: (values: Array<number | null>) => string;
}) {
  return (
    <G>
      {series.map((s) => (
        <G key={s.label}>
          <Polyline points={polyline(s.values)} fill="none" stroke={s.color} strokeWidth={2} />
          {/* A single-bucket range has no line to draw — mark the point. */}
          {s.values.length === 1 && <Circle cx={cx(0)} cy={y(s.values[0]!)} r={3} fill={s.color} />}
        </G>
      ))}
    </G>
  );
}

const PIE_SIZE = 168;
const PIE_R = 66;
const PIE_INNER = 36;

function PieChart({ series, currency }: { series: PlotSeries[]; currency: string }) {
  const total = series.reduce((sum, s) => sum + Math.max(0, s.total), 0);
  if (total <= 0) return <Text style={styles.empty}>No cost data for this period yet</Text>;

  const center = PIE_SIZE / 2;
  let angle = -Math.PI / 2;

  return (
    <View style={{ gap: spacing.sm }}>
      <Svg width="100%" height={PIE_SIZE} viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}>
        {series.map((s) => {
          const value = Math.max(0, s.total);
          if (value === 0) return null;
          const sweep = (value / total) * Math.PI * 2;
          // The 2px gap between slices, expressed as the angle it subtends.
          const gap = Math.min(sweep / 4, MARK_GAP / PIE_R);
          const from = angle + gap / 2;
          const to = angle + sweep - gap / 2;
          angle += sweep;
          return <Path key={s.label} d={donutSlice(center, from, to)} fill={s.color} />;
        })}
      </Svg>
      <Legend series={series} currency={currency} />
    </View>
  );
}

/** Donut wedge between two angles, as an SVG path. */
function donutSlice(center: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  const p = (radius: number, a: number) =>
    `${center + radius * Math.cos(a)},${center + radius * Math.sin(a)}`;
  return [
    `M${p(PIE_R, from)}`,
    `A${PIE_R},${PIE_R} 0 ${large} 1 ${p(PIE_R, to)}`,
    `L${p(PIE_INNER, to)}`,
    `A${PIE_INNER},${PIE_INNER} 0 ${large} 0 ${p(PIE_INNER, from)}`,
    "Z",
  ].join("");
}

/**
 * Identity is never carried by color alone: every series is named, and each
 * one wears its period total so the numbers survive the missing tooltip.
 */
function Legend({
  series,
  currency,
  extra = [],
}: {
  series: PlotSeries[];
  currency: string;
  extra?: Array<{ label: string; color: string }>;
}) {
  return (
    <View style={styles.legend}>
      {series.map((s) => (
        <View key={s.label} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: s.color }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {s.label}
          </Text>
          <Text style={styles.legendValue}>{formatMoney(s.total, currency)}</Text>
        </View>
      ))}
      {extra.map((e) => (
        <View key={e.label} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: e.color }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {e.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.textFaint, fontSize: 13, paddingVertical: spacing.lg },
  legend: { gap: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { color: colors.textMuted, fontSize: 11, flex: 1 },
  legendValue: { color: colors.textSecondary, fontSize: 11 },
});

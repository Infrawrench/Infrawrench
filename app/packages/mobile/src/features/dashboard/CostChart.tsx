import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
  bucketCostAnnotations,
  formatBucketLabel,
  formatCostAnnotationDates,
  formatMoney,
  niceAxis,
  totalPerBucket,
  OTHER_GROUP_KEY,
  type CostAnnotation,
  type CostAnnotationMarker,
  type CostBinningId,
  type CostChartType,
  type CostQueryResponse,
} from "@infrawrench/client-core";
import { colors, spacing } from "@/lib/theme";
import {
  Bars,
  EdgeLabels,
  GridTicks,
  CHART_HEIGHT as HEIGHT,
  CHART_WIDTH as WIDTH,
  MARK_GAP,
  PAD,
  PLOT_H,
  PLOT_W,
  SERIES_COLORS,
} from "./chart-primitives";

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

/** "Other" is always neutral — never a categorical hue. */
const OTHER_COLOR = "#6b7280";
/** The forecast overlay reads as the same measure, so it wears series one. */
const FORECAST_COLOR = SERIES_COLORS[0]!;
/**
 * The scenario overlay wears a *different* hue from the trend on purpose: the
 * two lines are different claims — one is what the data extrapolates to, the
 * other is what somebody says they know is coming — and a reader has to be able
 * to tell them apart at a glance on a phone.
 */
const SCENARIO_COLOR = SERIES_COLORS[2]!;

export interface CostChartProps {
  response: CostQueryResponse;
  chartType: CostChartType;
  binning: CostBinningId;
  currency: string;
  /**
   * Dated notes drawn over the chart, read-only. Mobile shows the markers and
   * the text on tap; writing one stays on web and desktop, where the date
   * picker and the org-wide/this-report choice belong.
   */
  annotations?: readonly CostAnnotation[] | undefined;
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

export function CostChart({ response, chartType, binning, currency, annotations }: CostChartProps) {
  const actualTotals = totalPerBucket(response.series);

  // Forecast buckets run past the observed ones, so they widen the axis.
  const forecastPoints = response.forecast
    ? binForecast(
        response.forecast,
        binning,
        binning === "cumulative" ? actualTotals[actualTotals.length - 1]?.amount : undefined,
      )
    : [];

  // The scenario covers exactly the forecast's days, so it never widens the
  // axis on its own — but it is unioned in anyway so a server/client mismatch
  // cannot silently drop points off the right-hand edge.
  const scenarioPoints = response.scenario
    ? binForecast(
        response.scenario.points,
        binning,
        binning === "cumulative" ? actualTotals[actualTotals.length - 1]?.amount : undefined,
      )
    : [];

  const buckets = [
    ...new Set([
      ...actualTotals.map((p) => p.bucket),
      ...forecastPoints.map((p) => p.bucket),
      ...scenarioPoints.map((p) => p.bucket),
    ]),
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

  // A second overlay beside the trend, never in place of it — the same rule
  // the web card follows, and the reason both are returned by the API.
  const scenario =
    scenarioPoints.length > 0 ? new Array<number | null>(buckets.length).fill(null) : null;
  if (scenario) {
    const lastActual = actualTotals[actualTotals.length - 1];
    if (lastActual) scenario[bucketIndex.get(lastActual.bucket)!] = lastActual.amount;
    for (const p of scenarioPoints) {
      const at = bucketIndex.get(p.bucket)!;
      scenario[at] = (scenario[at] ?? 0) + p.amount;
    }
  }

  const stackTotals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const plotted = [
    ...(stacked ? stackTotals : series.flatMap((s) => s.values)),
    ...(comparison ?? []),
    ...(forecast ?? []),
    ...(scenario ?? []),
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

  /**
   * Annotation markers, mapped onto the buckets this chart actually drew by the
   * shared `bucketCostAnnotations` — the same function the web card uses, so a
   * note lands on the same bar on a phone as on the dashboard it was written
   * from. Nothing here touches `series`, `axis`, or `buckets`: annotations are
   * an overlay, and the bars are identical with or without them.
   */
  const markers = bucketCostAnnotations(annotations ?? [], buckets, binning);

  return (
    <View style={{ gap: spacing.sm }}>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <GridTicks ticks={axis.ticks} y={y} format={(t) => formatMoney(t, currency)} />

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
        {scenario && (
          <Polyline
            points={polyline(scenario)}
            fill="none"
            stroke={SCENARIO_COLOR}
            strokeWidth={2}
            strokeDasharray="2 3"
          />
        )}

        {markers.map((marker) => {
          const at = bucketIndex.get(marker.bucket)!;
          const end = marker.endBucket ? bucketIndex.get(marker.endBucket) : undefined;
          const x = cx(at);
          return (
            <G key={marker.bucket}>
              {end !== undefined && end > at && (
                <Rect
                  x={PAD.left + bandWidth * at}
                  y={PAD.top}
                  width={bandWidth * (end - at + 1)}
                  height={PLOT_H}
                  fill={colors.textFaint}
                  opacity={0.1}
                />
              )}
              <SvgLine
                x1={x}
                y1={PAD.top}
                x2={x}
                y2={PAD.top + PLOT_H}
                stroke={colors.textMuted}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <SvgText
                x={x}
                y={PAD.top + 7}
                fill={colors.textMuted}
                fontSize={8}
                textAnchor="middle"
              >
                {marker.index}
              </SvgText>
            </G>
          );
        })}

        <EdgeLabels
          start={formatBucketLabel(buckets[0]!, binning)}
          end={buckets.length > 1 ? formatBucketLabel(buckets[buckets.length - 1]!, binning) : null}
        />
      </Svg>

      <Legend
        series={series}
        currency={currency}
        extra={[
          ...(comparison ? [{ label: "Previous period", color: colors.textMuted }] : []),
          ...(forecast ? [{ label: "Forecast (trend)", color: FORECAST_COLOR }] : []),
          // The model's *name*, not a generic "Scenario": a projection that
          // silently includes somebody's assumptions is worse than none, so the
          // legend has to say whose.
          ...(response.scenario && scenario
            ? [{ label: `Scenario: ${response.scenario.modelName}`, color: SCENARIO_COLOR }]
            : []),
        ]}
      />

      {markers.length > 0 && <AnnotationNotes markers={markers} />}
    </View>
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

/**
 * The notes behind the numbered flags, one row per marker.
 *
 * A phone has no hover, so the marker cannot be the only place the text lives —
 * the same reason the legend here carries each series' total instead of a
 * tooltip. Tapping a row expands every note on that bucket; several notes on
 * one bar are one row, matching the single flag drawn above.
 */
function AnnotationNotes({ markers }: { markers: CostAnnotationMarker[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={styles.notes}>
      {markers.map((marker) => {
        const expanded = open === marker.bucket;
        const first = marker.annotations[0]!;
        const more = marker.annotations.length - 1;
        return (
          <Pressable
            key={marker.bucket}
            onPress={() => setOpen(expanded ? null : marker.bucket)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`Annotation ${marker.index}, ${formatCostAnnotationDates(first)}: ${first.text}`}
            style={styles.noteRow}
          >
            <Text style={styles.noteIndex}>{marker.index}</Text>
            <View style={{ flex: 1 }}>
              {expanded ? (
                marker.annotations.map((annotation) => (
                  <View key={annotation.id} style={{ gap: 1 }}>
                    <Text style={styles.noteText}>{annotation.text}</Text>
                    <Text style={styles.noteDate}>{formatCostAnnotationDates(annotation)}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.noteText} numberOfLines={1}>
                  {first.text}
                  {more > 0 ? ` +${more}` : ""}
                </Text>
              )}
            </View>
            <Text style={styles.noteDate}>{formatCostAnnotationDates(first)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.textFaint, fontSize: 13, paddingVertical: spacing.lg },
  notes: { gap: 4, marginTop: spacing.xs },
  noteRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  noteIndex: { color: colors.textFaint, fontSize: 10, width: 12, textAlign: "center" },
  noteText: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
  noteDate: { color: colors.textFaint, fontSize: 10 },
  legend: { gap: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { color: colors.textMuted, fontSize: 11, flex: 1 },
  legendValue: { color: colors.textSecondary, fontSize: 11 },
});

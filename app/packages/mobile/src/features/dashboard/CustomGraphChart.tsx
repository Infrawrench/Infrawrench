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
  formatMoney,
  niceAxis,
  type CustomGraphChart as ChartSpec,
  type CustomGraphSeries,
} from "@infrawrench/client-core";
import { colors, spacing } from "@/lib/theme";

/**
 * The custom-graph chart, drawn with `react-native-svg` — recharts (which web
 * and desktop use for the same spec) is DOM-only. Axis maths comes from
 * client-core's `niceAxis`, so a bar lands on the same tick as on web. Series
 * arrive validated and capped by the sandbox dispatcher.
 *
 * Like the cost chart: no hover, so a legend carries each series' identity;
 * only the first and last x values are labelled.
 */

/** The app-wide categorical order (web `chart-theme.ts`), assigned per series. */
const SERIES_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c"];

const WIDTH = 320;
const HEIGHT = 168;
const PAD = { top: 8, right: 6, bottom: 18, left: 46 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const MARK_GAP = 2;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}/;

// Mirrors the web renderer's formatX (ui/src/custom-graphs/CustomGraphChart.tsx)
// so the same render spec labels its axis identically on both platforms —
// including the time-of-day suffix for datetime x values.
function formatX(x: string | number): string {
  if (typeof x === "number") return String(x);
  if (ISO_DAY_RE.test(x)) {
    const withTime = x.length > 10;
    const d = new Date(withTime ? x : `${x}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
        ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      });
    }
  }
  return x;
}

function formatValue(value: number, unit?: string, currency?: string): string {
  if (currency) return formatMoney(value, currency);
  const text = Math.abs(value) >= 100 ? value.toLocaleString() : String(Number(value.toFixed(2)));
  return unit ? `${text} ${unit}` : text;
}

function colorFor(index: number, override?: string): string {
  return override ?? SERIES_COLORS[index % SERIES_COLORS.length]!;
}

interface PlotSeries {
  label: string;
  color: string;
  /** Value per bucket index; null renders a gap on lines, 0 on bars/areas. */
  values: Array<number | null>;
}

function pivot(seriesSpecs: CustomGraphSeries[]): {
  buckets: Array<string | number>;
  series: PlotSeries[];
} {
  const order: Array<string | number> = [];
  const seen = new Set<string | number>();
  for (const s of seriesSpecs) {
    for (const p of s.points) {
      if (!seen.has(p.x)) {
        seen.add(p.x);
        order.push(p.x);
      }
    }
  }
  const sortable =
    order.every((x) => typeof x === "number") ||
    order.every((x) => typeof x === "string" && ISO_DAY_RE.test(x));
  if (sortable) order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map(order.map((x, i) => [x, i]));
  const series = seriesSpecs.map((s, i) => {
    const values = new Array<number | null>(order.length).fill(null);
    for (const p of s.points) values[index.get(p.x)!] = p.y;
    return { label: s.label ?? s.key, color: colorFor(i, s.color), values };
  });
  return { buckets: order, series };
}

export function CustomGraphChart({ spec }: { spec: ChartSpec }) {
  if (spec.type === "stat") {
    return (
      <View style={styles.stat}>
        <Text style={styles.statValue}>
          {typeof spec.value === "number"
            ? formatValue(spec.value, spec.unit, spec.currency)
            : spec.value}
        </Text>
        {spec.caption ? <Text style={styles.statCaption}>{spec.caption}</Text> : null}
      </View>
    );
  }

  if (spec.type === "table") {
    return (
      <View style={{ gap: 2 }}>
        <View style={styles.tableRow}>
          {spec.columns.map((c) => (
            <Text key={c} style={[styles.tableCell, styles.tableHeader]} numberOfLines={1}>
              {c}
            </Text>
          ))}
        </View>
        {spec.rows.slice(0, 30).map((row, i) => (
          <View key={i} style={styles.tableRow}>
            {spec.columns.map((_, j) => (
              <Text key={j} style={styles.tableCell} numberOfLines={1}>
                {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
              </Text>
            ))}
          </View>
        ))}
        {spec.rows.length > 30 ? (
          <Text style={styles.empty}>… {spec.rows.length - 30} more rows</Text>
        ) : null}
        {spec.rows.length === 0 ? <Text style={styles.empty}>No rows</Text> : null}
      </View>
    );
  }

  if (spec.type === "pie") {
    return <PieChart spec={spec} />;
  }

  const { buckets, series } = pivot(spec.series);
  if (buckets.length === 0 || series.length === 0) {
    return <Text style={styles.empty}>No data</Text>;
  }

  const stacked = spec.type === "stacked_bar" || spec.type === "area";
  const yUnit = spec.yAxis?.unit;
  const yCurrency = spec.yAxis?.currency;

  const stackTotals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const plotted = stacked
    ? stackTotals
    : series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const axis = niceAxis(Math.min(0, ...plotted), Math.max(0, ...plotted), 4);
  const [lo, hi] = axis.domain;

  const y = (value: number) => PAD.top + PLOT_H - ((value - lo) / (hi - lo || 1)) * PLOT_H;
  const band = PLOT_W / buckets.length;
  const cx = (i: number) => PAD.left + band * (i + 0.5);
  // A null y is a GAP, not a zero (the contract, and what web's
  // connectNulls={false} draws) — so a series becomes one polyline per
  // contiguous non-null run rather than one line joined across the holes.
  const lineSegments = (values: Array<number | null>): string[] => {
    const segments: string[] = [];
    let current: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined) {
        if (current.length > 0) segments.push(current.join(" "));
        current = [];
      } else {
        current.push(`${cx(i)},${y(v)}`);
      }
    }
    if (current.length > 0) segments.push(current.join(" "));
    return segments;
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
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
              {formatValue(t, yUnit, yCurrency)}
            </SvgText>
          </G>
        ))}

        {spec.type === "stacked_bar" || spec.type === "multi_bar" ? (
          <Bars series={series} bucketCount={buckets.length} stacked={stacked} band={band} y={y} />
        ) : spec.type === "area" ? (
          <Areas series={series} cx={cx} y={y} />
        ) : (
          <G>
            {series.map((s) =>
              lineSegments(s.values).map((points, si) =>
                points.includes(" ") ? (
                  <Polyline
                    key={`${s.label}:${si}`}
                    points={points}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                  />
                ) : (
                  // A run of one point has no line to draw — mark it so an
                  // isolated reading between two gaps stays visible.
                  <Circle
                    key={`${s.label}:${si}`}
                    cx={Number(points.split(",")[0])}
                    cy={Number(points.split(",")[1])}
                    r={2.5}
                    fill={s.color}
                  />
                ),
              ),
            )}
          </G>
        )}

        <SvgText x={PAD.left} y={HEIGHT - 5} fill={colors.textFaint} fontSize={8}>
          {formatX(buckets[0]!)}
        </SvgText>
        {buckets.length > 1 && (
          <SvgText
            x={WIDTH - PAD.right}
            y={HEIGHT - 5}
            fill={colors.textFaint}
            fontSize={8}
            textAnchor="end"
          >
            {formatX(buckets[buckets.length - 1]!)}
          </SvgText>
        )}
      </Svg>

      {series.length > 1 && (
        <View style={styles.legend}>
          {series.map((s) => (
            <View key={s.label} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text style={styles.legendLabel} numberOfLines={1}>
                {s.label}
              </Text>
            </View>
          ))}
        </View>
      )}
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
  const count = series[0]?.values.length ?? 0;
  const running = new Array<number>(count).fill(0);
  return (
    <G>
      {series.map((s) => {
        const base = [...running];
        for (let i = 0; i < count; i++) running[i] = (running[i] ?? 0) + (s.values[i] ?? 0);
        const top = [...running];
        const forward = top.map((v, i) => `${cx(i)},${y(v)}`).join(" L");
        const backward = [...base]
          .reverse()
          .map((v, i) => `${cx(count - 1 - i)},${y(v)}`)
          .join(" L");
        return (
          <Path
            key={s.label}
            d={`M${forward} L${backward} Z`}
            fill={s.color}
            fillOpacity={0.35}
            stroke={s.color}
            strokeWidth={1.5}
          />
        );
      })}
    </G>
  );
}

function PieChart({ spec }: { spec: Extract<ChartSpec, { type: "pie" }> }) {
  const total = spec.slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return <Text style={styles.empty}>No data</Text>;
  const cx = 80;
  const cy = 80;
  const r = 64;
  let angle = -Math.PI / 2;
  const arcs = spec.slices.map((s, i) => {
    const frac = Math.max(0, s.value) / total;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    return {
      d: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`,
      color: colorFor(i, s.color),
      label: s.label,
      value: s.value,
    };
  });
  return (
    <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "center" }}>
      <Svg width={128} height={128} viewBox="0 0 160 160">
        {arcs.map((a, i) => (
          <Path key={i} d={a.d} fill={a.color} stroke={colors.surface} strokeWidth={2} />
        ))}
      </Svg>
      <View style={{ flex: 1, gap: 3 }}>
        {arcs.map((a, i) => (
          <View key={i} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: a.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {a.label} · {formatValue(a.value, spec.unit, spec.currency)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.textFaint, fontSize: 12, paddingVertical: spacing.md },
  stat: { alignItems: "center", paddingVertical: spacing.lg, gap: 4 },
  statValue: { color: colors.text, fontSize: 28, fontWeight: "600" },
  statCaption: { color: colors.textFaint, fontSize: 12 },
  tableRow: { flexDirection: "row", gap: spacing.sm },
  tableCell: { flex: 1, color: colors.textMuted, fontSize: 11 },
  tableHeader: { color: colors.textFaint, fontWeight: "600" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "48%" },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
});

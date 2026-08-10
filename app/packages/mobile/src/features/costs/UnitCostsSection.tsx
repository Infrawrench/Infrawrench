import { StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  describeUnitCostCaveats,
  formatUnitCostValue,
  unitCostUnitLabel,
  type UnitCostQueryResponse,
  type UnitCostSeries,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useBusinessMetrics, useUnitCostSeries } from "./useUnitCosts";

const WIDTH = 320;
const HEIGHT = 44;

/**
 * A sparkline that **breaks on a gap**.
 *
 * This is the whole reason the mobile card draws its own path instead of
 * reusing a generic sparkline: a bucket with no reported metric value arrives
 * as `null`, and a line that bridged it would draw straight across days nobody
 * measured and make them look measured. Each run of consecutive numbers becomes
 * its own `<Path>`; a gap is simply the absence of one.
 */
function GapAwareSparkline({ values, color }: { values: Array<number | null>; color: string }) {
  const numbers = values.filter((v): v is number => v !== null);
  if (numbers.length < 2) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const span = max - min || 1;
  const step = values.length > 1 ? WIDTH / (values.length - 1) : WIDTH;

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = i * step;
    const y = HEIGHT - ((value - min) / span) * (HEIGHT - 4) - 2;
    current.push(`${current.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  return (
    <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      {segments.map((d, i) => (
        <Path key={i} d={d} stroke={color} strokeWidth={2} fill="none" />
      ))}
    </Svg>
  );
}

/**
 * Native counterpart to the unit-cost cards on web and desktop: what one of the
 * things the business does costs, over the trailing 30 days.
 *
 * Read-only. Creating a metric, scoping it and reporting its values are
 * deliberate omissions on the phone (see `useUnitCosts.ts`) — the same stance
 * mobile takes on tag policy, exchange rates and anomaly tuning. What is *not*
 * omitted is the honesty: a period nobody reported is drawn as a break in the
 * line and named in the caveat under it, never as a zero.
 */
export function UnitCostsSection() {
  const metricsQuery = useBusinessMetrics();
  const metrics = metricsQuery.data ?? [];
  const series = useUnitCostSeries(metrics);

  // An org with no business metrics stays quiet rather than advertising an
  // empty report — the same rule the tag governance section follows.
  if (!metricsQuery.isLoading && !metricsQuery.isError && metrics.length === 0) return null;

  return (
    <>
      <SectionTitle>Unit costs</SectionTitle>

      {metricsQuery.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load business metrics —{" "}
            {metricsQuery.error instanceof Error ? metricsQuery.error.message : "request failed"}
          </Text>
        </Card>
      ) : metricsQuery.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading unit costs…</Text>
        </Card>
      ) : (
        series.map((query, i) => {
          const metric = metrics[i];
          if (!metric) return null;
          return (
            <UnitCostCard
              key={metric.id}
              name={metric.name}
              response={query.data ?? null}
              loading={query.isLoading}
              error={query.isError}
            />
          );
        })
      )}

      <Text style={styles.footnote}>
        Last 30 days. Business metrics are declared and reported from the web or desktop app; this
        list is read-only.
      </Text>
    </>
  );
}

function UnitCostCard({
  name,
  response,
  loading,
  error,
}: {
  name: string;
  response: UnitCostQueryResponse | null;
  loading: boolean;
  error: boolean;
}) {
  if (error) {
    return (
      <Card>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.error}>Couldn&apos;t load this metric&apos;s unit costs.</Text>
      </Card>
    );
  }
  if (loading || !response) {
    return (
      <Card>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.muted}>Loading…</Text>
      </Card>
    );
  }

  const caveat = describeUnitCostCaveats(response);
  return (
    <Card>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.headline}>
          {response.series
            .map((s) => formatUnitCostValue(s.overallValue, response.mode))
            .join(" · ") || "—"}
        </Text>
      </View>
      <Text style={styles.subtitle}>
        {response.series
          .map((s) => unitCostUnitLabel(response.metric, response.mode, s.currency))
          .join(" · ") || "per unit"}
      </Text>

      {response.series.map((s: UnitCostSeries, i: number) => (
        <GapAwareSparkline
          key={s.currency}
          values={s.points.map((p) => p.value)}
          color={SERIES_COLORS[i % SERIES_COLORS.length]!}
        />
      ))}

      {caveat && <Text style={styles.caveat}>{caveat}</Text>}
    </Card>
  );
}

/** Same palette the cost chart uses, so a metric reads as one system with it. */
const SERIES_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f87171"];

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flex: 1 },
  headline: { color: colors.text, fontSize: 15, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm },
  caveat: { color: colors.warning, fontSize: 11, marginTop: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

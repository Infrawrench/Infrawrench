import { StyleSheet, Text, View } from "react-native";
import {
  costForecastComparisonRows,
  formatMoney,
  hasForecastBand,
  type CostForecastResult,
} from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * A report's forecasts as rows: the automatic trend first, then each named
 * forecast with its window total, its band, and how far it sits from the
 * trend. The same comparison the web and desktop Forecasts section tabulates,
 * through the same `costForecastComparisonRows`, without the editor.
 */
export function ForecastList({ result }: { result: CostForecastResult }) {
  const currency = result.currency ?? "USD";
  const fmt = (n: number) => formatMoney(n, currency);
  const rows = costForecastComparisonRows(result);
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={styles.caption}>
        {result.lastObservedDay
          ? `${result.from} to ${result.to}, from spend through ${result.lastObservedDay}. Ranges are ${result.confidenceLevel}% intervals.`
          : "No spend collected for this report's scope yet."}
      </Text>
      <Card list>
        {rows.map((row) => (
          <View key={row.forecastId ?? "baseline"} style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name}>
                {row.forecastId === null ? "Automatic (trend)" : row.name}
                {row.isDefault ? "  · default" : ""}
              </Text>
              {hasForecastBand(row.total) ? (
                <Text style={styles.detail}>
                  {fmt(row.total.low)} to {fmt(row.total.high)}
                </Text>
              ) : null}
              {row.warnings.map((w) => (
                <Text key={w} style={styles.warning}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={styles.amount}>{fmt(row.total.expected)}</Text>
              {row.forecastId !== null ? (
                <Text style={styles.detail}>
                  {row.deltaFromBaseline >= 0 ? "+" : "−"}
                  {fmt(Math.abs(row.deltaFromBaseline))}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { color: colors.textMuted, fontSize: 12 },
  row: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  name: { color: colors.text, fontSize: 14, fontWeight: "500" },
  amount: { color: colors.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  detail: { color: colors.textMuted, fontSize: 12 },
  warning: { color: colors.warning, fontSize: 12 },
});

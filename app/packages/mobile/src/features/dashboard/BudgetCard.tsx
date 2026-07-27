import { StyleSheet, Text, View } from "react-native";
import { formatBudgetMonth, formatMoney, type BudgetWithStatus } from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Native counterpart to the web/desktop `BudgetCard`: month-to-date actual
 * against the budget amount, the forecast marker, threshold ticks, and an
 * alert badge once a threshold has fired this month. Same numbers, same
 * status colors — a budget alert that lands as a push reads the same here as
 * on the dashboard it was configured on.
 */
export function BudgetCard({ budget }: { budget: BudgetWithStatus }) {
  const amount = budget.amountCents / 100;
  const actual = budget.actualCents / 100;
  const forecast = budget.forecastCents === null ? null : budget.forecastCents / 100;

  const actualPct = amount > 0 ? (actual / amount) * 100 : 0;
  const forecastPct = forecast !== null && amount > 0 ? (forecast / amount) * 100 : null;
  const fired = budget.currentMonthEvents.length > 0;

  const barColor =
    actualPct >= 100 ? colors.danger : actualPct >= 80 ? colors.warning : colors.success;

  return (
    <Card>
      <View style={styles.titleRow}>
        <Text style={styles.name} numberOfLines={1}>
          {budget.name}
        </Text>
        {fired && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Alert</Text>
          </View>
        )}
      </View>

      <View style={styles.amountRow}>
        <Text style={styles.actual}>{formatMoney(actual, budget.currency)}</Text>
        <Text style={styles.of}>
          of {formatMoney(amount, budget.currency)} · {formatBudgetMonth(budget.month)}
        </Text>
      </View>

      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${Math.min(100, actualPct)}%`, backgroundColor: barColor },
          ]}
        />
        {forecastPct !== null && forecastPct > actualPct && (
          <View style={[styles.forecastMark, { left: `${Math.min(100, forecastPct)}%` }]} />
        )}
        {budget.thresholds.map((t, i) => (
          <View
            key={`${t.type}-${t.percent}-${i}`}
            style={[styles.thresholdTick, { left: `${Math.min(100, t.percent)}%` }]}
          />
        ))}
      </View>

      <View style={styles.footRow}>
        <Text style={styles.foot}>{actualPct.toFixed(0)}% used</Text>
        {forecast !== null && (
          <Text style={styles.foot}>
            Forecast {formatMoney(forecast, budget.currency)}
            {amount > 0 ? ` (${((forecast / amount) * 100).toFixed(0)}%)` : ""}
          </Text>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  badge: {
    backgroundColor: "rgba(248, 113, 113, 0.15)",
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: colors.danger, fontSize: 10, fontWeight: "600" },
  amountRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  actual: { color: colors.text, fontSize: 20, fontWeight: "600" },
  of: { color: colors.textFaint, fontSize: 11, flexShrink: 1, textAlign: "right" },
  track: {
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surfaceOverlay,
    overflow: "hidden",
  },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 5 },
  forecastMark: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.textMuted,
  },
  thresholdTick: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.textFaint,
  },
  footRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  foot: { color: colors.textFaint, fontSize: 11 },
});

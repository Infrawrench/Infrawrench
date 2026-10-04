import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  budgetProgress,
  formatBudgetMonth,
  formatBudgetPeriodWindow,
  formatMoney,
  formatUsageQuantity,
  upcomingBudgetPeriod,
  type BudgetHierarchyWarning,
  type BudgetWithStatus,
} from "@infrawrench/client-core";
import { Card } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/** Formats a value in the budget's own unit: money, or a usage quantity. */
export function budgetFormatter(budget: BudgetWithStatus): (value: number) => string {
  return budget.measure === "usage"
    ? (value) => formatUsageQuantity(value, budget.usageUnit)
    : (value) => formatMoney(value, budget.currency);
}

function periodLabel(budget: BudgetWithStatus): string {
  if (!budget.period) return formatBudgetMonth(budget.month);
  if (budget.periodStart && budget.periodEnd) {
    return formatBudgetPeriodWindow({ start: budget.periodStart, end: budget.periodEnd });
  }
  const next = upcomingBudgetPeriod(budget.period, new Date().toISOString().slice(0, 10));
  return next
    ? `No active period · next starts ${formatBudgetPeriodWindow({ start: next.start, end: next.start })}`
    : "No active period";
}

function warningText(budget: BudgetWithStatus, w: BudgetHierarchyWarning): string {
  const fmt = budgetFormatter(budget);
  // Both figures arrive in the API's unit: cents for money, the quantity for usage.
  const scale = budget.measure === "usage" ? 1 : 100;
  const total = fmt(w.childTotal / scale);
  const limit = fmt(w.parentLimit / scale);
  if (w.kind === "allocation") {
    return `Child budgets allocate ${total}, more than this budget's ${limit}`;
  }
  if (w.kind === "actual")
    return `Child budgets have reached ${total}, past this budget's ${limit}`;
  return `Child budgets are forecast to reach ${total}, past this budget's ${limit}`;
}

/**
 * Native counterpart to the web/desktop `BudgetCard`: period-to-date actual
 * against the period's limit, the forecast marker, threshold ticks, and an
 * alert badge once a threshold has fired this period. Spend budgets read in
 * money, usage budgets in their unit, and a parent says it is the sum of its
 * children. Same numbers, same status colors: a budget alert that lands as a
 * push reads the same here as on the dashboard it was configured on.
 */
export function BudgetCard({
  budget,
  childBudgets,
}: {
  budget: BudgetWithStatus;
  /** Direct children, listed (collapsed) under a parent's dashboard card. */
  childBudgets?: BudgetWithStatus[] | undefined;
}) {
  const progress = budgetProgress(budget);
  const fmt = budgetFormatter(budget);
  const { limit, actual, forecast, trendForecast, actualPercent: actualPct } = progress;
  const forecastPct = progress.forecastPercent;
  const fired = budget.currentMonthEvents.length > 0;

  const barColor =
    actualPct >= 100 ? colors.danger : actualPct >= 80 ? colors.warning : colors.success;
  const period = periodLabel(budget);

  return (
    <Card>
      <View style={styles.titleRow}>
        <Text style={styles.name} numberOfLines={1}>
          {budget.name}
        </Text>
        {budget.measure === "usage" && (
          <View style={styles.neutralBadge}>
            <Text style={styles.neutralBadgeText}>Usage</Text>
          </View>
        )}
        {fired && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Alert</Text>
          </View>
        )}
      </View>

      <View style={styles.amountRow}>
        <Text style={styles.actual}>{progress.active ? fmt(actual) : "—"}</Text>
        <Text style={styles.of}>{limit !== null ? `of ${fmt(limit)} · ${period}` : period}</Text>
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
            Forecast {fmt(forecast)}
            {forecastPct !== null ? ` (${forecastPct.toFixed(0)}%)` : ""}
          </Text>
        )}
      </View>
      {/* Named on the card rather than hidden in a tooltip a phone has no way
          to show: the figure the thresholds fire on contains assumptions
          somebody wrote down, and the trend it was measured against. */}
      {budget.scenarioModelName && (
        <Text style={styles.scenarioFoot}>
          incl. scenario “{budget.scenarioModelName}”
          {trendForecast !== null ? ` · trend ${fmt(trendForecast)}` : ""}
        </Text>
      )}
      {budget.rolledUp ? (
        <Text style={styles.foot}>Sum of {budget.childCount ?? 0} child budgets</Text>
      ) : null}
      {(budget.hierarchyWarnings ?? []).map((w) => (
        <Text key={w.kind} style={styles.warning}>
          ⚠ {warningText(budget, w)}
        </Text>
      ))}
      {childBudgets && childBudgets.length > 0 ? <ChildList budgets={childBudgets} /> : null}
    </Card>
  );
}

function ChildList({ budgets }: { budgets: BudgetWithStatus[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.children}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
      >
        <Text style={styles.childToggle}>
          {open ? "▾" : "▸"} {budgets.length} child budgets
        </Text>
      </Pressable>
      {open
        ? budgets.map((child) => {
            const p = budgetProgress(child);
            const fmt = budgetFormatter(child);
            const color =
              p.actualPercent >= 100
                ? colors.danger
                : p.actualPercent >= 80
                  ? colors.warning
                  : colors.success;
            return (
              <View key={child.id} style={{ gap: 2 }}>
                <View style={styles.footRow}>
                  <Text style={styles.childName} numberOfLines={1}>
                    {child.name}
                  </Text>
                  <Text style={styles.foot}>
                    {p.limit !== null ? `${fmt(p.actual)} of ${fmt(p.limit)}` : fmt(p.actual)}
                  </Text>
                </View>
                <View style={styles.miniTrack}>
                  <View
                    style={[
                      styles.fill,
                      { width: `${Math.min(100, p.actualPercent)}%`, backgroundColor: color },
                    ]}
                  />
                </View>
              </View>
            );
          })
        : null}
    </View>
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
  neutralBadge: {
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  neutralBadgeText: { color: colors.textMuted, fontSize: 10, fontWeight: "600" },
  amountRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  actual: { color: colors.text, fontSize: 20, fontWeight: "600" },
  of: { color: colors.textFaint, fontSize: 11, flexShrink: 1, textAlign: "right" },
  track: {
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surfaceOverlay,
    overflow: "hidden",
  },
  miniTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceOverlay,
    overflow: "hidden",
  },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 5 },
  scenarioFoot: { color: colors.warning, fontSize: 11 },
  warning: { color: colors.warning, fontSize: 11 },
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
  children: {
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  childToggle: { color: colors.textMuted, fontSize: 12 },
  childName: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
});

import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  SLO_BURN_WINDOWS,
  buildSloHistory,
  formatBudgetDuration,
  formatBurnRate,
  formatSloPercent,
  formatSloTarget,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { SchemaNodeView } from "@/schema/SchemaRenderer";
import { colors, spacing } from "@/lib/theme";
import { sloBudgetLine, sloSourceLine, sloStatusColor, sloStatusLabel } from "./format";
import { useSloDetail } from "./useSlos";

/**
 * One SLO, read-only: status, SLI against target, budget left (as a share and
 * as time), burn rates per alerting window, and the two charts web draws,
 * rendered through the native metric chart the schema renderer already has.
 * Editing and the change-freeze suggestion's button stay on web/desktop.
 */
export function SloDetailScreen({ sloId }: { sloId: string }) {
  const detail = useSloDetail(sloId);
  const history = useMemo(
    () =>
      detail.data
        ? buildSloHistory(detail.data.buckets, detail.data.slo.targetPercent)
        : { dailySli: [], budgetBurndown: [] },
    [detail.data],
  );

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError || !detail.data) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Couldn't load the SLO."}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const { slo, activeFreeze } = detail.data;
  const budget = sloBudgetLine(slo);

  return (
    <Screen onRefresh={() => void detail.refetch()} refreshing={detail.isRefetching}>
      <View style={styles.header}>
        <Text style={styles.name}>{slo.name}</Text>
        <Text style={styles.subtitle}>{sloSourceLine(slo)}</Text>
        <Text style={[styles.status, { color: sloStatusColor(slo) }]}>{sloStatusLabel(slo)}</Text>
        {slo.description ? <Text style={styles.body}>{slo.description}</Text> : null}
      </View>

      {slo.status === "exhausted" && slo.suggestFreeze && !activeFreeze && (
        <Text style={styles.warning}>
          The error budget is spent. Consider a change freeze; it can be started from this SLO on
          the web or desktop app.
        </Text>
      )}
      {activeFreeze && (
        <Text style={styles.body}>Change freeze in effect: {activeFreeze.name}</Text>
      )}
      {slo.lastError && <Text style={styles.warning}>{slo.lastError}</Text>}

      <Card>
        <Stat
          label="Current SLI"
          value={slo.sli === null ? "no data" : formatSloPercent(slo.sli)}
        />
        <Stat
          label="Target"
          value={`${formatSloTarget(slo.targetPercent)} over ${slo.windowDays} days`}
        />
        <Stat label="Budget" value={budget ?? "no data"} />
        <Stat label="Whole budget" value={formatBudgetDuration(slo.budgetTotalMinutes)} />
      </Card>

      <SectionTitle>Burn rates</SectionTitle>
      <Card>
        <View style={styles.burnRow}>
          {SLO_BURN_WINDOWS.map((w) => {
            const rate = slo.burnRates[w];
            return (
              <View key={w} style={styles.burnCell}>
                <Text style={styles.burnWindow}>{w}</Text>
                <Text style={styles.burnValue}>
                  {rate === null || rate === undefined ? "-" : formatBurnRate(rate)}
                </Text>
              </View>
            );
          })}
        </View>
      </Card>

      {history.dailySli.length > 0 && (
        <SchemaNodeView
          node={{
            kind: "metric-chart",
            title: "SLI per day",
            series: [
              {
                label: "Daily SLI",
                unit: "%",
                points: history.dailySli.map((p) => ({ timestamp: p.tsMs, value: p.value })),
              },
            ],
            timeRangeLabel: `Last ${slo.windowDays} days`,
          }}
        />
      )}
      {history.budgetBurndown.length > 0 && (
        <SchemaNodeView
          node={{
            kind: "metric-chart",
            title: "Error budget burndown",
            series: [
              {
                label: "Budget remaining",
                unit: "%",
                points: history.budgetBurndown.map((p) => ({ timestamp: p.tsMs, value: p.value })),
              },
            ],
            timeRangeLabel: "Share of the budget left after each hour",
          }}
        />
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  name: { color: colors.text, fontSize: 18, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  status: { fontSize: 13, fontWeight: "600" },
  body: { color: colors.textMuted, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 13 },
  stat: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  statLabel: { color: colors.textMuted, fontSize: 13 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: "500" },
  burnRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  burnCell: { alignItems: "center", flex: 1 },
  burnWindow: { color: colors.textFaint, fontSize: 11 },
  burnValue: { color: colors.text, fontSize: 14, fontWeight: "500" },
});

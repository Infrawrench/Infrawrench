import { StyleSheet, Text, View } from "react-native";
import {
  COST_ANOMALY_DIMENSION_LABELS,
  costAnomalyDeltaPercent,
  formatMoney,
  type CostAnomaly,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";
import { ANOMALY_WINDOW_DAYS, useCostAnomalies } from "./useCostAnomalies";

/**
 * Native counterpart to `CostAnomaliesSection` on web and desktop — the last
 * 30 days of detected spend anomalies, on the Costs tab.
 *
 * This is where a `cost_anomaly` push lands (`pushDataToPath` routes it to
 * `/org/:orgId/costs`), so the notification has to open something that
 * actually contains the anomaly it is about.
 *
 * A row is one of two findings and they read differently: a **spike** is spend
 * far above the key's own trailing baseline, so it shows the baseline and the
 * percentage it cleared it by; a **new spend source** has no baseline at all,
 * so it shows a badge, `none`, and `new`. Never a percentage — see
 * `costAnomalyDeltaPercent`, which the three surfaces share precisely because
 * that rule is easy to get subtly wrong.
 */
export function CostAnomaliesSection() {
  const anomalies = useCostAnomalies();
  const rows = anomalies.data ?? [];

  return (
    <>
      <SectionTitle>Anomalies</SectionTitle>

      {anomalies.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load anomalies —{" "}
            {anomalies.error instanceof Error ? anomalies.error.message : "request failed"}
          </Text>
        </Card>
      ) : anomalies.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading anomalies…</Text>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            No spend anomalies in the last {ANOMALY_WINDOW_DAYS} days. Each day&apos;s spend is
            compared per provider and per service against its trailing 28-day baseline, and anything
            that starts spending with no history at all is flagged separately.
          </Text>
        </Card>
      ) : (
        <Card list>
          {rows.map((a) => (
            <AnomalyRow key={a.id} anomaly={a} />
          ))}
        </Card>
      )}

      {rows.length > 0 && (
        <Text style={styles.footnote}>
          Detection thresholds — and whether anomalies also text the on-call list — are per
          organization; tune them from the web or desktop app.
        </Text>
      )}
    </>
  );
}

/** "Jul 28" in UTC — the day the anomaly is about, not the local rendering of it. */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function AnomalyRow({ anomaly }: { anomaly: CostAnomaly }) {
  const isNew = anomaly.kind === "new_source";
  const delta = costAnomalyDeltaPercent(anomaly);

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {anomaly.dimensionKey}
          </Text>
          {isNew && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>New source</Text>
            </View>
          )}
        </View>
        <Text style={styles.subtitle} numberOfLines={1}>
          {formatDay(anomaly.day)} · {COST_ANOMALY_DIMENSION_LABELS[anomaly.dimension]}
        </Text>
        <Text style={styles.baseline} numberOfLines={1}>
          {isNew
            ? "No prior spend in the trailing 28 days"
            : `Baseline ${formatMoney(anomaly.baselineCents / 100, anomaly.currency)}/day`}
        </Text>
      </View>
      <View style={styles.rowAmount}>
        <Text style={styles.amount}>
          {formatMoney(anomaly.actualCents / 100, anomaly.currency)}
        </Text>
        <Text style={[styles.delta, { color: isNew ? colors.warning : colors.danger }]}>
          {delta ?? "new"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  rowAmount: { alignItems: "flex-end", gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  baseline: { color: colors.textFaint, fontSize: 11 },
  amount: { color: colors.text, fontSize: 15, fontWeight: "600" },
  delta: { fontSize: 12, fontWeight: "500" },
  badge: {
    borderColor: "rgba(251, 191, 36, 0.4)",
    backgroundColor: "rgba(251, 191, 36, 0.1)",
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { color: colors.warning, fontSize: 10, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

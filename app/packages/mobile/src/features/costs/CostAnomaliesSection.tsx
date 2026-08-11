import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import {
  COST_ANOMALY_DIMENSION_LABELS,
  costAnomalyDeltaPercent,
  formatMoney,
  type CostAnomaly,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { FileIssueSheet } from "@/features/issue-filing/FileIssueSheet";
import { useFilableTrackers, useIssueLinks } from "@/features/issue-filing/useIssueFiling";
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
 * Explaining a finding is **read-only here**: the composer, the annotation it
 * creates and the org-wide scope choice all live on web and desktop, where the
 * charts it draws on are. What mobile owes a reader is the answer — an
 * explained anomaly says so, and says what somebody established it was, so the
 * person who gets the push at 7am is not left working out a spike that was
 * settled yesterday.
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
  // Optional on the wire — an app a release ahead of its server still renders.
  const hints = anomaly.hints ?? [];

  const { linksFor } = useIssueLinks();
  const trackers = useFilableTrackers();
  const [filing, setFiling] = useState(false);
  const links = linksFor("cost_anomaly", anomaly.id);
  const fileLabel =
    trackers.length > 1
      ? "File an issue"
      : trackers[0] === "jira"
        ? "File in Jira"
        : "File in Linear";

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
          {anomaly.acknowledgement && (
            <View style={styles.explainedBadge}>
              <Text style={styles.explainedBadgeText}>Explained</Text>
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
        {/* Read-only on purpose — see the component note. */}
        {anomaly.acknowledgement && (
          <Text style={styles.explanation} numberOfLines={3}>
            {anomaly.acknowledgement.explanation}
          </Text>
        )}
        {hints.map((hint) => (
          <Text key={hint} style={styles.hint} numberOfLines={2}>
            · {hint}
          </Text>
        ))}
        {/* Filed → the issue key/identifier, which opens the tracker — one
            badge per tracker holding a link (both, if both do). Not filed but
            filable → the offer, labelled by what is connected. Neither →
            nothing, rather than a control that can only fail. Same three
            states as the web button. */}
        {links.jira || links.linear ? (
          <View style={styles.linkRow}>
            {links.jira && (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(links.jira!.issueUrl)}
              >
                <Text style={styles.issueLink}>{links.jira.issueKey}</Text>
              </Pressable>
            )}
            {links.linear && (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(links.linear!.issueUrl)}
              >
                <Text style={styles.issueLink}>{links.linear.issueIdentifier}</Text>
              </Pressable>
            )}
          </View>
        ) : trackers.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setFiling(true)}>
            <Text style={styles.issueAction}>{fileLabel}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.rowAmount}>
        <Text style={styles.amount}>
          {formatMoney(anomaly.actualCents / 100, anomaly.currency)}
        </Text>
        <Text style={[styles.delta, { color: isNew ? colors.warning : colors.danger }]}>
          {delta ?? "new"}
        </Text>
      </View>
      {filing && (
        <FileIssueSheet
          visible={filing}
          trackers={trackers}
          sourceKind="cost_anomaly"
          sourceId={anomaly.id}
          draft={{
            title: `${anomaly.dimensionKey} spend ${isNew ? "started" : `up ${delta ?? ""}`} on ${anomaly.day}`,
            details: [
              { label: "Day", value: anomaly.day },
              {
                label: COST_ANOMALY_DIMENSION_LABELS[anomaly.dimension],
                value: anomaly.dimensionKey,
              },
              {
                label: "Spend",
                value: formatMoney(anomaly.actualCents / 100, anomaly.currency),
              },
              {
                label: "Baseline / day",
                value: isNew
                  ? "none (new source)"
                  : formatMoney(anomaly.baselineCents / 100, anomaly.currency),
              },
              { label: "Change", value: delta },
              { label: "Detected", value: anomaly.detectedAt },
            ],
            ...(hints.length > 0
              ? { note: `What changed around this window:\n${hints.join("\n")}` }
              : {}),
          }}
          onClose={() => setFiling(false)}
        />
      )}
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
  explanation: { color: colors.text, fontSize: 12, marginTop: 2 },
  hint: { color: colors.textFaint, fontSize: 11 },
  linkRow: { flexDirection: "row", gap: spacing.sm },
  issueLink: { color: colors.accent, fontSize: 11, fontWeight: "600", marginTop: 2 },
  issueAction: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
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
  explainedBadge: {
    borderColor: "rgba(16, 185, 129, 0.4)",
    backgroundColor: "rgba(16, 185, 129, 0.1)",
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  explainedBadgeText: { color: colors.success, fontSize: 10, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

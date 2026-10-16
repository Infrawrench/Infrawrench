import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  COMMITMENT_KIND_LABELS,
  COMMITMENT_REPORT_GRANULARITY_LABELS,
  COMMITMENT_REPORT_GROUP_BY_LABELS,
  COMMITMENT_REPORT_METRIC_LABELS,
  COMMITMENT_REPORT_ON_DEMAND_KEY,
  COMMITMENT_REPORT_UNATTRIBUTED_KEY,
  COMMITMENT_REPORT_UNKNOWN_KIND_KEY,
  formatMoney,
  type CommitmentReport,
  type CommitmentReportMetricValues,
  type CommitmentReportRunResult,
  type CommitmentReportSeries,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { useCommitmentReportRun, useCommitmentReports } from "./useCommitmentReports";

/**
 * Saved commitment reports, read-only: the list, and one report's headline
 * and per-group totals when a row is opened. Creating and editing stay on web
 * and desktop, like cost reports. A null ratio prints "—", never 0%.
 */
export function CommitmentReportsSection() {
  const reports = useCommitmentReports();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = reports.data ?? [];
  if (reports.isLoading || reports.isError || list.length === 0) return null;
  return (
    <>
      <SectionTitle>Commitment reports</SectionTitle>
      <Card list>
        {list.map((report) => (
          <ReportRow
            key={report.id}
            report={report}
            open={openId === report.id}
            onToggle={() => setOpenId(openId === report.id ? null : report.id)}
          />
        ))}
      </Card>
    </>
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function money(value: number | null, currency: string): string {
  return value === null ? "—" : formatMoney(value, currency);
}

function groupLabel(s: CommitmentReportSeries, run: CommitmentReportRunResult): string {
  if (s.groupKey === COMMITMENT_REPORT_ON_DEMAND_KEY) return "On demand (not covered)";
  if (s.groupKey === COMMITMENT_REPORT_UNATTRIBUTED_KEY) return "Covered, commitment not reported";
  if (s.groupKey === COMMITMENT_REPORT_UNKNOWN_KIND_KEY) return "Commitment not in inventory";
  if (run.groupBy === "commitment_type" && s.groupKey in COMMITMENT_KIND_LABELS) {
    return COMMITMENT_KIND_LABELS[s.groupKey as keyof typeof COMMITMENT_KIND_LABELS];
  }
  return s.label || "Not set";
}

function MetricsLine({ m, currency }: { m: CommitmentReportMetricValues; currency: string }) {
  return (
    <Text style={styles.subtitle}>
      Coverage {pct(m.coverage)} · utilization {pct(m.utilization)} · savings{" "}
      {money(m.netSavings, currency)} · unused {money(m.unusedCommitmentCost, currency)}
    </Text>
  );
}

function ReportRow({
  report,
  open,
  onToggle,
}: {
  report: CommitmentReport;
  open: boolean;
  onToggle: () => void;
}) {
  const run = useCommitmentReportRun(report.id, open);
  const data = run.data;
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.title}>{report.name}</Text>
        <Text style={styles.subtitle}>
          {COMMITMENT_REPORT_METRIC_LABELS[report.config.metric]} ·{" "}
          {COMMITMENT_REPORT_GRANULARITY_LABELS[report.config.granularity]} ·{" "}
          {COMMITMENT_REPORT_GROUP_BY_LABELS[report.config.groupBy]}
        </Text>
      </Pressable>
      {open && (
        <View style={styles.detail}>
          {run.isLoading && <Text style={styles.muted}>Running report…</Text>}
          {run.isError && (
            <Text style={styles.error}>
              {run.error instanceof Error ? run.error.message : "request failed"}
            </Text>
          )}
          {data && (
            <>
              <Text style={styles.footnote}>
                {data.from} to {data.to}, amortized
              </Text>
              {data.overall.map((s) => (
                <View key={s.id}>
                  <Text style={styles.label}>
                    {data.overall.length > 1 ? `${s.currency} total` : "Total"}
                  </Text>
                  <MetricsLine m={s.total.metrics} currency={s.currency} />
                </View>
              ))}
              {data.groupBy !== "none" &&
                data.series.slice(0, 10).map((s) => (
                  <View key={s.id}>
                    <Text style={styles.label} numberOfLines={1}>
                      {groupLabel(s, data)}
                    </Text>
                    <MetricsLine m={s.total.metrics} currency={s.currency} />
                  </View>
                ))}
              {data.providers
                .filter((p) => p.status === "inventory_only")
                .map((p) => (
                  <Text key={p.pluginId} style={styles.footnote}>
                    {p.displayName}: holdings only, its cost data cannot measure coverage.
                  </Text>
                ))}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: spacing.sm },
  detail: { gap: 6 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  label: { color: colors.text, fontSize: 13, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

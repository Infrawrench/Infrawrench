import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  doraTrendDirection,
  formatDeployFrequency,
  formatDoraHours,
  formatDoraRate,
  type DoraBand,
  type DoraChange,
  type DoraMetric,
  type DoraReport,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Screen, SectionTitle, TabStrip } from "@/components/ui";
import { SchemaNodeView } from "@/schema/SchemaRenderer";
import { colors, spacing } from "@/lib/theme";
import { useDoraChanges, useDoraReport } from "./useDelivery";

const RANGES = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
] as const;

const BAND_LABEL: Record<DoraBand, string> = {
  elite: "Elite",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function bandColor(band: DoraBand | null): string {
  switch (band) {
    case "elite":
      return colors.success;
    case "high":
      return colors.accent;
    case "medium":
      return colors.warning;
    case "low":
      return colors.danger;
    case null:
      return colors.textFaint;
  }
}

function deltaText(metric: DoraMetric, cur: number | null, prev: number | null): string | null {
  const dir = doraTrendDirection(metric, cur, prev);
  if (dir === "better") return "Better than the previous period";
  if (dir === "worse") return "Worse than the previous period";
  if (dir === "flat") return "Same as the previous period";
  return null;
}

/**
 * Delivery: the native counterpart of the web/desktop Delivery tab and
 * `infrawrench dora`. The four DORA numbers for production with their bands
 * and the previous period, the deploy trend, a breakdown by the scope
 * dimensions, and the changes behind the failure rate.
 *
 * Read-only by design: the settings (what counts as production, the failure
 * window) are an org-wide editor, the drift-settings stance, and stay on
 * web/desktop and Terraform.
 */
export function DeliveryScreen() {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("30");
  const [groupBy, setGroupBy] = useState("environment");
  const report = useDoraReport(Number(range), groupBy);

  if (report.isLoading) return <LoadingView />;
  if (report.isError || !report.data) {
    return (
      <ErrorView
        message={
          report.error instanceof Error ? report.error.message : "Couldn't load delivery metrics."
        }
        onRetry={() => void report.refetch()}
      />
    );
  }
  const data = report.data;
  const empty = data.eventCount === 0 && data.summary.changeFailureRate.changes === 0;

  return (
    <Screen onRefresh={() => void report.refetch()} refreshing={report.isRefetching}>
      <TabStrip tabs={RANGES} value={range} onChange={setRange} />
      {empty ? (
        <Text style={styles.footnote}>
          No deploys in this range yet. Delivery metrics come from Infrawrench deploys, deploys your
          providers already sync, CI pipelines named as deploys, GitHub deployments and deploys
          recorded over the API.
        </Text>
      ) : (
        <>
          <Metrics report={data} />
          <SchemaNodeView
            node={{
              kind: "metric-chart",
              title: "Production deploys",
              series: [
                {
                  label: "Deploys",
                  points: data.trend.map((b) => ({
                    timestamp: Date.parse(b.start),
                    value: b.deploys,
                  })),
                },
              ],
              timeRangeLabel: data.bucket === "week" ? "Per week" : "Per day",
            }}
          />
          <SectionTitle>Breakdown</SectionTitle>
          <TabStrip
            tabs={data.dimensions.map((d) => ({ id: d.id, label: d.label }))}
            value={groupBy}
            onChange={setGroupBy}
          />
          <Card list>
            {data.breakdown.map((row) => (
              <View key={row.key ?? "\u0000none"} style={styles.row}>
                <Text style={styles.title} numberOfLines={1}>
                  {row.key === null ? "Not known" : row.label}
                </Text>
                <Text style={styles.detail} numberOfLines={1}>
                  {`${row.summary.deploymentFrequency.deploys} deploys · lead ${formatDoraHours(row.summary.leadTime.value)} · failure ${formatDoraRate(row.summary.changeFailureRate.value)} · restore ${formatDoraHours(row.summary.timeToRestore.value)}`}
                </Text>
              </View>
            ))}
          </Card>
          <FailedChanges days={Number(range)} />
        </>
      )}
    </Screen>
  );
}

function Metrics({ report }: { report: DoraReport }) {
  const s = report.summary;
  const p = report.previous;
  const tiles: Array<{
    title: string;
    value: string;
    detail: string;
    band: DoraBand | null;
    delta: string | null;
  }> = [
    {
      title: "Deployment frequency",
      value:
        s.deploymentFrequency.deploys > 0
          ? formatDeployFrequency(s.deploymentFrequency.value)
          : "None",
      detail: `${s.deploymentFrequency.deploys} production deploys`,
      band: s.deploymentFrequency.band,
      delta: deltaText(
        "deployment_frequency",
        s.deploymentFrequency.value,
        p.deploymentFrequency.value,
      ),
    },
    {
      title: "Lead time for changes",
      value: formatDoraHours(s.leadTime.value),
      detail:
        s.leadTime.sample > 0 ? `Median of ${s.leadTime.sample} deploys` : "No commit times known",
      band: s.leadTime.band,
      delta: deltaText("lead_time", s.leadTime.value, p.leadTime.value),
    },
    {
      title: "Change failure rate",
      value: formatDoraRate(s.changeFailureRate.value),
      detail: `${s.changeFailureRate.failures} of ${s.changeFailureRate.changes} changes failed`,
      band: s.changeFailureRate.band,
      delta: deltaText("change_failure_rate", s.changeFailureRate.value, p.changeFailureRate.value),
    },
    {
      title: "Time to restore",
      value: formatDoraHours(s.timeToRestore.value),
      detail: `Median of ${s.timeToRestore.restores} recoveries`,
      band: s.timeToRestore.band,
      delta: deltaText("time_to_restore", s.timeToRestore.value, p.timeToRestore.value),
    },
  ];
  return (
    <Card list>
      {tiles.map((t) => (
        <View
          key={t.title}
          style={styles.row}
          accessible
          accessibilityLabel={`${t.title}: ${t.value}, ${t.band ? BAND_LABEL[t.band] : "not enough data"}`}
        >
          <View style={styles.rowMain}>
            <Text style={styles.subtitle}>{t.title}</Text>
            <Text style={styles.value}>{t.value}</Text>
            <Text style={styles.detail}>{t.detail}</Text>
            {t.delta && <Text style={styles.detail}>{t.delta}</Text>}
          </View>
          <Text style={[styles.band, { color: bandColor(t.band) }]}>
            {t.band ? BAND_LABEL[t.band] : "No data"}
          </Text>
        </View>
      ))}
    </Card>
  );
}

function failureLine(c: DoraChange): string {
  const f = c.failure;
  if (!f) return "";
  switch (f.kind) {
    case "incident":
      return `Incident: ${f.title}`;
    case "rollback":
      return "Rolled back";
    case "failed_deploy":
      return "The deploy failed";
    case "reverted":
      return "Reverted";
  }
}

function FailedChanges({ days }: { days: number }) {
  const changes = useDoraChanges(days, true);
  const list = changes.data?.changes ?? [];
  return (
    <>
      <SectionTitle>Failed changes</SectionTitle>
      {changes.isLoading ? (
        <Text style={styles.footnote}>Loading…</Text>
      ) : list.length === 0 ? (
        <Text style={styles.footnote}>No failed production changes in this range.</Text>
      ) : (
        <Card list>
          {list.slice(0, 50).map((c) => (
            <View key={c.id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.title} numberOfLines={1}>
                  {c.name}
                  {c.environment ? ` · ${c.environment}` : ""}
                </Text>
                <Text style={[styles.detail, { color: colors.danger }]} numberOfLines={1}>
                  {failureLine(c)}
                </Text>
                <Text style={styles.detail}>{new Date(c.at).toLocaleString()}</Text>
              </View>
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  value: { color: colors.text, fontSize: 22, fontWeight: "600" },
  detail: { color: colors.textFaint, fontSize: 11 },
  band: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

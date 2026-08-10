import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  costQueryForConfig,
  describeCostConversion,
  formatMoney,
  type CostGraphConfig,
  type CostQueryResponse,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { CostChart } from "./CostChart";
import { useCostAnnotations } from "@/features/cost-reports/useCostAnnotations";

/**
 * A cost-graph widget on mobile: the same `/costs/query` the web and desktop
 * cards run, the same headline total and period delta, rendered with the
 * native {@link CostChart}. Read-only — the widget is configured on web or
 * desktop, and this honours whatever it says.
 */
export function CostGraphCard({
  title,
  config,
  annotationReportId,
}: {
  title: string;
  config: CostGraphConfig;
  /**
   * Draw this report's own notes alongside the org-wide ones. Absent on a
   * dashboard card, which belongs to no report and so sees org-wide notes only.
   */
  annotationReportId?: string | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const request = useMemo(() => costQueryForConfig(config), [config]);

  const query = useQuery({
    queryKey: ["cost-query", orgId, request],
    queryFn: () =>
      api.org<CostQueryResponse>(orgId, "/costs/query", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });

  // Read-only markers. A failed fetch leaves the chart drawn and unannotated:
  // the numbers are the point of the card, and the notes are commentary on them.
  const annotations = useCostAnnotations(annotationReportId);

  const response = query.data ?? null;
  const currency = response?.currencies[0] ?? "USD";
  const mixedCurrency = (response?.currencies.length ?? 0) > 1;
  const conversionNote = describeCostConversion(response?.conversion);
  const total = response
    ? Object.entries(response.totals)
        .map(([cur, amt]) => formatMoney(amt, cur))
        .join(" + ")
    : null;

  const deltaPct = (() => {
    if (!response?.previousTotals) return null;
    const previous = response.previousTotals[currency] ?? 0;
    if (previous === 0) return null;
    return (((response.totals[currency] ?? 0) - previous) / previous) * 100;
  })();

  return (
    <Card>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title || "Costs"}
        </Text>
        {total && <Text style={styles.total}>{total}</Text>}
        {deltaPct !== null && (
          <Text style={[styles.delta, { color: deltaPct > 0 ? colors.danger : colors.success }]}>
            {deltaPct > 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
          </Text>
        )}
      </View>
      {mixedCurrency && (
        <Text style={styles.note}>Mixed currencies — series are shown per currency.</Text>
      )}
      {/*
        A converted total has to carry its caveat on the card, next to the
        number. Mobile has no rate editor (a deliberate omission), so this is
        the only place a phone reader learns the figure is a conversion at
        rates their org stated rather than a collected one.
      */}
      {conversionNote && <Text style={styles.note}>{conversionNote}</Text>}
      {/*
        An applied scenario is stated on the card, not left to the legend. A
        phone screenshot pasted into a thread has to carry the fact that part of
        its line is an assumption and whose it is. Mobile is read-only here by
        design — models are authored on web or desktop — but a card that draws
        one must say so as loudly as the card that made it.
      */}
      {response?.scenario && (
        <Text style={styles.scenarioNote}>
          Projection includes scenario “{response.scenario.modelName}” (
          {response.scenario.totalDelta >= 0 ? "+" : "−"}
          {formatMoney(Math.abs(response.scenario.totalDelta), response.scenario.currency)} over the
          horizon). The trend line is the unadjusted forecast.
          {response.scenario.outOfScope.length > 0 &&
            ` Not applied here: ${response.scenario.outOfScope.join(", ")}.`}
        </Text>
      )}

      {query.isLoading ? (
        <Text style={styles.state}>Loading costs…</Text>
      ) : query.isError ? (
        <Text style={[styles.state, { color: colors.danger }]}>
          {query.error instanceof Error ? query.error.message : "Failed to load costs"}
        </Text>
      ) : response ? (
        <CostChart
          response={response}
          chartType={config.chartType}
          binning={config.binning}
          currency={currency}
          annotations={annotations.data ?? []}
        />
      ) : (
        <Text style={styles.state}>No cost data for this period yet</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  total: { color: colors.textSecondary, fontSize: 13 },
  delta: { fontSize: 11 },
  note: { color: colors.textFaint, fontSize: 11 },
  scenarioNote: { color: colors.warning, fontSize: 11 },
  state: { color: colors.textFaint, fontSize: 13, paddingVertical: spacing.lg },
});

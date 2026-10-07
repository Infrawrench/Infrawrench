import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  compareSloStatus,
  formatSloPercent,
  formatSloTarget,
  type Slo,
} from "@infrawrench/client-core";
import { Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { IssueIndicator } from "@/components/IssueIndicator";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { sloBudgetLine, sloSourceLine, sloStatusColor, sloStatusLabel } from "./format";
import { useSlos } from "./useSlos";

/**
 * SLOs; the native counterpart of the web/desktop SLOs tab and the
 * `infrawrench slos` CLI: every objective, worst first, with its SLI against
 * the target and the error budget left.
 *
 * Read-only by design (the probes stance): SLOs are written on web/desktop,
 * where the probe and metric pickers live, and so is starting a change freeze
 * from a spent budget. This screen answers the `slo_alert` push's question:
 * how bad, and is it still burning.
 */
export function SlosScreen() {
  const slos = useSlos();

  if (slos.isLoading) return <LoadingView />;
  if (slos.isError) {
    return (
      <ErrorView
        message={slos.error instanceof Error ? slos.error.message : "Couldn't load SLOs."}
        onRetry={() => void slos.refetch()}
      />
    );
  }

  const list = [...(slos.data?.slos ?? [])].sort(
    (a, b) => compareSloStatus(a.status, b.status) || a.name.localeCompare(b.name),
  );
  if (list.length === 0) {
    return (
      <EmptyView message="No SLOs yet. Create one on the web or desktop app from a probe or a resource metric." />
    );
  }

  return (
    <Screen onRefresh={() => void slos.refetch()} refreshing={slos.isRefetching}>
      <Card list>
        {list.map((slo) => (
          <SloRow key={slo.id} slo={slo} />
        ))}
      </Card>
      <Text style={styles.footnote}>
        Measured from your probes and metrics over a rolling window. SLOs are managed on the web or
        desktop app.
      </Text>
    </Screen>
  );
}

function SloRow({ slo }: { slo: Slo }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const budget = sloBudgetLine(slo);
  const sli = slo.sli === null ? "no data" : formatSloPercent(slo.sli);
  const detail = `${sli} / ${formatSloTarget(slo.targetPercent)}${budget ? ` · ${budget}` : ""}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${slo.name}, ${sloStatusLabel(slo)}, ${detail}`}
      onPress={() => router.push(`/org/${orgId}/slos/${slo.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {slo.enabled && (slo.status === "exhausted" || slo.status === "fast_burn") && (
        <IssueIndicator tone="danger" reason={sloStatusLabel(slo)} />
      )}
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {slo.name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {sloSourceLine(slo)}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text style={[styles.status, { color: sloStatusColor(slo) }]}>{sloStatusLabel(slo)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  detail: { color: colors.textFaint, fontSize: 11 },
  status: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});

import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  formatKubernetesEfficiency,
  formatMoney,
  K8S_COST_CATEGORY_LABELS,
  K8S_EFFICIENCY_ROW_KIND_LABELS,
  K8S_USAGE_STATE_COLORS,
  K8S_USAGE_STATE_LABELS,
  K8S_USAGE_STATES,
  type KubernetesEfficiencyCurrencyResult,
  type KubernetesEfficiencyFigures,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { useKubernetesEfficiencyRun } from "@/features/k8s-efficiency/useKubernetesEfficiency";
import { colors, spacing } from "@/lib/theme";

/** A proportional bar of a figure set's usage states. */
function StateBar({ figures }: { figures: KubernetesEfficiencyFigures }) {
  const total = figures.total || 1;
  return (
    <View
      style={{
        flexDirection: "row",
        height: 8,
        borderRadius: 4,
        overflow: "hidden",
        backgroundColor: colors.surfaceOverlay,
      }}
    >
      {K8S_USAGE_STATES.map((s) =>
        figures[s] > 0 ? (
          <View
            key={s}
            style={{ flex: figures[s] / total, backgroundColor: K8S_USAGE_STATE_COLORS[s] }}
          />
        ) : null,
      )}
    </View>
  );
}

function Block({ block }: { block: KubernetesEfficiencyCurrencyResult }) {
  const money = (n: number) => formatMoney(n, block.currency);
  const t = block.totals;
  return (
    <>
      <Card>
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: "600" }}>
            {formatKubernetesEfficiency(t.efficiency)}
            <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: "400" }}>
              {" "}
              efficient · {money(t.total)}
            </Text>
          </Text>
          {t.measuredShare !== null && t.measuredShare < 0.999 ? (
            <Text style={{ color: colors.warning, fontSize: 12 }}>
              {Math.round(t.measuredShare * 100)}% of the cost was measured
            </Text>
          ) : null}
          <StateBar figures={t} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {K8S_USAGE_STATES.map((s) => (
              <Text key={s} style={{ color: colors.textMuted, fontSize: 12 }}>
                <Text style={{ color: K8S_USAGE_STATE_COLORS[s] }}>■ </Text>
                {K8S_USAGE_STATE_LABELS[s]} {money(t[s])}
              </Text>
            ))}
          </View>
        </View>
      </Card>

      {block.categories.length > 0 ? (
        <>
          <SectionTitle>By cost category</SectionTitle>
          <Card list>
            {block.categories.map(({ category, figures }) => (
              <Row
                key={category}
                title={K8S_COST_CATEGORY_LABELS[category]}
                subtitle={`${money(figures.total)} · ${formatKubernetesEfficiency(figures.efficiency)} efficient`}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle>Groups</SectionTitle>
      <Card list>
        {block.rows.map((row) => (
          <Row
            key={row.key}
            title={row.kind === "group" ? row.label : K8S_EFFICIENCY_ROW_KIND_LABELS[row.kind]}
            subtitle={`${money(row.figures.total)} · used ${money(row.figures.used)} · idle ${money(
              row.figures.idle,
            )}`}
            right={
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }}>
                {formatKubernetesEfficiency(row.figures.efficiency)}
              </Text>
            }
          />
        ))}
      </Card>
    </>
  );
}

/**
 * One Kubernetes efficiency report, read-only. Pull to refresh re-runs it.
 * Editing, filters and export stay on web and desktop, the same line cost
 * report editing draws.
 */
export default function KubernetesEfficiencyDetailRoute() {
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const run = useKubernetesEfficiencyRun(reportId);

  if (run.isLoading) return <LoadingView />;
  if (run.isError || !run.data) {
    return (
      <ErrorView
        message={
          run.error instanceof Error
            ? run.error.message
            : "This report no longer exists or is not shared with you."
        }
        onRetry={() => void run.refetch()}
      />
    );
  }
  const { name, result } = run.data;
  return (
    <Screen onRefresh={() => void run.refetch()} refreshing={run.isRefetching}>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{name}</Text>
        <Text style={{ color: colors.textFaint, fontSize: 12 }}>
          {result.from} to {result.to} · efficiency of{" "}
          {result.basis === "allocated" ? "allocated" : "total"} cost
        </Text>
        {result.includesLegacyRows ? (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            Part of this window predates the CPU, memory and usage split; that cost counts as
            unmeasured.
          </Text>
        ) : null}
      </View>
      {result.currencies.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          No Kubernetes cost in this window yet.
        </Text>
      ) : (
        result.currencies.map((block) => <Block key={block.currency} block={block} />)
      )}
    </Screen>
  );
}

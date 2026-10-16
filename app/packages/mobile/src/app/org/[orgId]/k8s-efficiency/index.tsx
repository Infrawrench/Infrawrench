import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { useKubernetesEfficiencyReports } from "@/features/k8s-efficiency/useKubernetesEfficiency";
import { colors } from "@/lib/theme";

const GROUP_BY_LABELS: Record<string, string> = {
  cluster: "by cluster",
  namespace: "by namespace",
  workload: "by workload",
  label: "by label",
  node_pool: "by node pool",
  category: "by cost category",
};

/**
 * The org's Kubernetes efficiency reports, read-only. Reports are created and
 * edited on web and desktop; the phone reads them.
 */
export default function KubernetesEfficiencyRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const reports = useKubernetesEfficiencyReports();

  if (reports.isLoading) return <LoadingView />;
  if (reports.isError) {
    return (
      <ErrorView
        message={reports.error instanceof Error ? reports.error.message : "Failed to load"}
        onRetry={() => void reports.refetch()}
      />
    );
  }
  const rows = reports.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyView message="No Kubernetes efficiency reports yet. Create one on the Kubernetes efficiency page on web or desktop." />
    );
  }
  return (
    <Screen onRefresh={() => void reports.refetch()} refreshing={reports.isRefetching}>
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
        How much of each cluster’s cost bought capacity that was used, requested but unused, or sat
        idle.
      </Text>
      <Card list>
        {rows.map((report) => (
          <Row
            key={report.id}
            title={report.name}
            subtitle={
              report.description ??
              (report.config.groupBy === "label"
                ? `by ${report.config.groupByLabelKey ?? "label"}`
                : GROUP_BY_LABELS[report.config.groupBy])
            }
            onPress={() => router.push(`/org/${orgId}/k8s-efficiency/${report.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}

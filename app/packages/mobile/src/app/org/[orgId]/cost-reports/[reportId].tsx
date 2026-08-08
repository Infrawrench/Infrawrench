import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { useCostReports } from "@/features/cost-reports/useCostReports";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/**
 * One saved cost report, read-only.
 *
 * The chart is the same {@link CostGraphCard} a dashboard cost widget uses,
 * pointed at the report's stored config — a report *is* that config with a
 * name, so drawing it any other way would be a second implementation of the
 * same picture.
 *
 * Editing is deliberately absent on mobile (see the list screen): choosing a
 * chart type, binning, group-by and filter set is a desktop job, and a
 * half-editor here would be the fastest way to change a report five dashboards
 * depend on by accident.
 */
export default function CostReportDetailRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const reports = useCostReports();

  if (reports.isLoading) return <LoadingView />;
  if (reports.isError) {
    return (
      <ErrorView
        message={reports.error instanceof Error ? reports.error.message : "Failed to load"}
        onRetry={() => void reports.refetch()}
      />
    );
  }

  const report = (reports.data ?? []).find((r) => r.id === reportId);
  if (!report) {
    return (
      <ErrorView
        message="This report no longer exists. It may have been deleted from web or desktop."
        onRetry={() => void reports.refetch()}
      />
    );
  }

  return (
    <Screen onRefresh={() => void reports.refetch()} refreshing={reports.isRefetching}>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{report.name}</Text>
        {report.description ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>{report.description}</Text>
        ) : null}
      </View>

      <CostGraphCard title={report.name} config={report.config} />

      <SectionTitle>On dashboards</SectionTitle>
      {report.placements.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          No dashboard shows this report. It still exists and still runs — a report is an org
          object, not a dashboard card.
        </Text>
      ) : (
        <Card list>
          {report.placements.map((placement) => (
            <Row
              key={placement.widgetId}
              title={placement.dashboardName}
              onPress={() => router.push(`/org/${orgId}/dashboard/${placement.dashboardId}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

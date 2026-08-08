import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { useCostReports } from "@/features/cost-reports/useCostReports";
import { colors } from "@/lib/theme";

/**
 * The org's saved cost reports — named cost graphs, listed so one can be
 * opened and read on a phone.
 *
 * Read-only, deliberately, the way mobile treats budgets: authoring a report
 * means picking a chart type, a binning, a group-by and a filter set, which is
 * a desktop job. Everything that makes a report worth having on a phone — the
 * numbers, and which dashboards depend on it — is here.
 */
export default function CostReportsRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
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

  const rows = reports.data ?? [];

  return (
    <Screen onRefresh={() => void reports.refetch()} refreshing={reports.isRefetching}>
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
        A saved cost graph with a name. One report can appear on many dashboards — editing it on web
        or desktop updates all of them.
      </Text>

      {rows.length === 0 ? (
        <EmptyView message="No saved cost reports yet. Save one from the Reports page on web or desktop and it will show up here." />
      ) : (
        <Card list>
          {rows.map((report) => (
            <Row
              key={report.id}
              title={report.name}
              subtitle={
                report.description ??
                (report.placements.length === 0
                  ? "On no dashboard"
                  : report.placements.length === 1
                    ? `On ${report.placements[0]!.dashboardName}`
                    : `On ${report.placements.length} dashboards`)
              }
              onPress={() => router.push(`/org/${orgId}/cost-reports/${report.id}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

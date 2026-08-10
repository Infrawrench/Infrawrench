import { Text } from "react-native";
import { useRouter } from "expo-router";
import type { CostReport } from "@infrawrench/client-core";
import { flattenCostReportFolderTree } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { useCostReportFolders, useCostReports } from "@/features/cost-reports/useCostReports";
import { colors } from "@/lib/theme";

/**
 * The org's saved cost reports — named cost graphs, listed so one can be
 * opened and read on a phone.
 *
 * Read-only, deliberately, the way mobile treats budgets: authoring a report
 * means picking a chart type, a binning, a group-by and a filter set, which is
 * a desktop job. The same goes for folders — the list groups by the folders
 * web and desktop maintain (section per folder, named by its full path, empty
 * folders omitted), but creating, renaming, nesting or deleting one stays
 * there too. Everything that makes a report worth having on a phone — the
 * numbers, and which dashboards depend on it — is here.
 */
export default function CostReportsRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const reports = useCostReports();
  const folders = useCostReportFolders();

  if (reports.isLoading || folders.isLoading) return <LoadingView />;
  if (reports.isError || folders.isError) {
    const error = reports.error ?? folders.error;
    return (
      <ErrorView
        message={error instanceof Error ? error.message : "Failed to load"}
        onRetry={() => {
          void reports.refetch();
          void folders.refetch();
        }}
      />
    );
  }

  const rows = reports.data ?? [];
  const folderRows = folders.data ?? [];

  // Same defensive grouping the web list applies: a report filed in a folder
  // this client can't see lands at the top level rather than vanishing.
  const knownFolders = new Set(folderRows.map((f) => f.id));
  const byFolder = new Map<string | null, CostReport[]>();
  for (const report of rows) {
    const key =
      report.folderId !== null && knownFolders.has(report.folderId) ? report.folderId : null;
    const list = byFolder.get(key) ?? [];
    list.push(report);
    byFolder.set(key, list);
  }
  const sections = flattenCostReportFolderTree(folderRows)
    .map((row) => ({ path: row.path, reports: byFolder.get(row.folder.id) ?? [] }))
    .filter((s) => s.reports.length > 0);
  const unfiled = byFolder.get(null) ?? [];

  const reportRow = (report: CostReport) => (
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
  );

  return (
    <Screen
      onRefresh={() => {
        void reports.refetch();
        void folders.refetch();
      }}
      refreshing={reports.isRefetching || folders.isRefetching}
    >
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
        A saved cost graph with a name. One report can appear on many dashboards — editing it on web
        or desktop updates all of them.
      </Text>

      {rows.length === 0 ? (
        <EmptyView message="No saved cost reports yet. Save one from the Reports page on web or desktop and it will show up here." />
      ) : (
        <>
          {unfiled.length > 0 && <Card list>{unfiled.map(reportRow)}</Card>}
          {sections.map((section) => (
            <Card key={section.path}>
              <SectionTitle>{section.path}</SectionTitle>
              <RowGroup>{section.reports.map(reportRow)}</RowGroup>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}

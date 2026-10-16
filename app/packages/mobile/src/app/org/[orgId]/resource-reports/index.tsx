import { Text } from "react-native";
import { useRouter } from "expo-router";
import {
  flattenCostReportFolderTree,
  resourceReportFilterCount,
  type ResourceReport,
} from "@infrawrench/client-core";
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
import {
  useResourceReportFolders,
  useResourceReports,
} from "@/features/resource-reports/useResourceReports";
import { colors } from "@/lib/theme";

/**
 * The org's saved resource reports, grouped by the report folders web and
 * desktop maintain.
 *
 * Read-only, the cost reports stance: building a report means picking columns
 * from the org's metadata and tag keys and setting filters, which is a desktop
 * job. Reading one (what we have and what each thing costs) is what a phone
 * is for.
 */
export default function ResourceReportsRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const reports = useResourceReports();
  const folders = useResourceReportFolders();

  if (reports.isLoading || folders.isLoading) return <LoadingView />;
  if (reports.isError) {
    return (
      <ErrorView
        message={reports.error instanceof Error ? reports.error.message : "Failed to load"}
        onRetry={() => void reports.refetch()}
      />
    );
  }

  const rows = reports.data ?? [];
  const folderRows = folders.data ?? [];
  const known = new Set(folderRows.map((f) => f.id));
  const byFolder = new Map<string | null, ResourceReport[]>();
  for (const report of rows) {
    const key = report.folderId !== null && known.has(report.folderId) ? report.folderId : null;
    const list = byFolder.get(key) ?? [];
    list.push(report);
    byFolder.set(key, list);
  }
  const sections: { path: string; reports: ResourceReport[] }[] = [];
  for (const row of flattenCostReportFolderTree(folderRows)) {
    const inFolder = byFolder.get(row.folder.id);
    if (inFolder && inFolder.length > 0) sections.push({ path: row.path, reports: inFolder });
  }
  const unfiled = byFolder.get(null) ?? [];

  const reportRow = (report: ResourceReport) => {
    const filters = resourceReportFilterCount(report.config.filters);
    return (
      <Row
        key={report.id}
        title={report.name}
        subtitle={
          report.description ??
          `${report.config.columns.length} columns · ${filters} filter${filters === 1 ? "" : "s"}`
        }
        onPress={() => router.push(`/org/${orgId}/resource-reports/${report.id}`)}
      />
    );
  };

  return (
    <Screen
      onRefresh={() => {
        void reports.refetch();
        void folders.refetch();
      }}
      refreshing={reports.isRefetching || folders.isRefetching}
    >
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>
        Saved tables of your synced resources with what each one costs. Build and edit them on web
        or desktop.
      </Text>
      {rows.length === 0 ? (
        <EmptyView message="No resource reports yet. Create one from Resource reports on web or desktop and it will show up here." />
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

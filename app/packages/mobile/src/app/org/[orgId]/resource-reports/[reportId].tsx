import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  formatResourceReportMoney,
  type ResourceReportColumn,
  type ResourceReportRow,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import {
  useResourceReportRows,
  useResourceReports,
} from "@/features/resource-reports/useResourceReports";
import { colors, spacing } from "@/lib/theme";

/** One cell as text: cost formatted, the created timestamp as a day, empty as a dash. */
function cellText(row: ResourceReportRow, col: ResourceReportColumn): string {
  if (col.kind === "cost") {
    const cell = row.costs[col.id] ?? [];
    return cell.length > 0 ? formatResourceReportMoney(cell) : "-";
  }
  const text = row.values[col.id];
  if (!text) return "-";
  return col.kind === "core" && col.key === "created" ? text.slice(0, 10) : text;
}

/**
 * One saved resource report, read-only: its rows as a list, the first column
 * as each row's title and the rest (labelled) underneath, in the report's
 * saved order and sort. Tapping a row opens the resource.
 */
export default function ResourceReportDetailRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const reports = useResourceReports();
  const rows = useResourceReportRows(reportId);

  if (reports.isLoading || rows.isLoading) return <LoadingView />;
  const report = (reports.data ?? []).find((r) => r.id === reportId);
  if (reports.isError || rows.isError || !report) {
    const error = reports.error ?? rows.error;
    return (
      <ErrorView
        message={
          error instanceof Error
            ? error.message
            : "This report no longer exists. It may have been deleted from web or desktop."
        }
        onRetry={() => {
          void reports.refetch();
          void rows.refetch();
        }}
      />
    );
  }

  const pages = rows.data?.pages ?? [];
  const first = pages[0];
  const columns = first?.columns ?? [];
  const all = pages.flatMap((p) => p.rows);
  const total = first?.total ?? 0;
  const [titleCol, ...rest] = columns;
  const range = first?.cost?.windows.find((w) => w.window === "range");

  return (
    <Screen onRefresh={() => void rows.refetch()} refreshing={rows.isRefetching}>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{report.name}</Text>
        {report.description ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>{report.description}</Text>
        ) : null}
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {`${total}${first?.truncated ? "+" : ""} resource${total === 1 ? "" : "s"}`}
          {first?.cost && !first.cost.available
            ? ` · cost columns are empty: ${first.cost.reason ?? "no cost data"}`
            : range
              ? ` · accrued cost ${range.from} to ${range.to}`
              : ""}
        </Text>
      </View>

      {all.length === 0 ? (
        <EmptyView message="No resources match this report's filters." />
      ) : (
        <Card list>
          {all.map((row) => (
            <Row
              key={row.id}
              title={titleCol ? cellText(row, titleCol) : row.id}
              subtitle={rest.map((col) => `${col.label}: ${cellText(row, col)}`).join("\n")}
              onPress={() =>
                router.push(
                  `/org/${orgId}/resources/${encodeURIComponent(row.pluginId)}/${encodeURIComponent(
                    row.resourceTypeId,
                  )}/${encodeURIComponent(row.id)}?accountId=${encodeURIComponent(row.accountId)}`,
                )
              }
            />
          ))}
        </Card>
      )}

      {rows.hasNextPage && (
        <Button
          label={rows.isFetchingNextPage ? "Loading…" : `Load more (${all.length} of ${total})`}
          variant="secondary"
          disabled={rows.isFetchingNextPage}
          onPress={() => void rows.fetchNextPage()}
        />
      )}
    </Screen>
  );
}

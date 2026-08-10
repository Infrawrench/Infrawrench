import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  describeReportSchedule,
  describeReportTargets,
  type ReportNotification,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { CostGraphCard } from "@/features/dashboard/CostGraphCard";
import { useCostReports } from "@/features/cost-reports/useCostReports";
import { useReportNotifications } from "@/features/cost-reports/useReportNotifications";
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
 * depend on by accident. Delivery schedules follow the same rule: shown with
 * their last-send status, created and edited on web/desktop only. Annotations
 * likewise: the chart draws this report's notes and the org-wide ones, and the
 * text is a tap away, but writing one — which can change what every chart in
 * the org shows — stays on web and desktop.
 */
export default function CostReportDetailRoute() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const reports = useCostReports();
  const notifications = useReportNotifications(reportId);

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

      <CostGraphCard title={report.name} config={report.config} annotationReportId={report.id} />

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

      <SectionTitle>Delivery</SectionTitle>
      {notifications.isLoading ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading schedules…</Text>
      ) : notifications.isError ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          Couldn&rsquo;t load delivery schedules.
        </Text>
      ) : (notifications.data ?? []).length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          No scheduled delivery. Schedules are managed on web or desktop.
        </Text>
      ) : (
        <Card list>
          {(notifications.data ?? []).map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Sending…",
  succeeded: "Delivered",
  partial: "Partially delivered",
  failed: "Failed",
  no_targets: "No live destinations",
};

/** One schedule, read-only: when it fires, where it goes, how the last send went. */
function NotificationRow({ notification: n }: { notification: ReportNotification }) {
  const failed =
    n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets";
  const status = n.lastStatus ? (STATUS_LABELS[n.lastStatus] ?? n.lastStatus) : "Not sent yet";
  const lastSent = n.lastSentAt
    ? new Date(n.lastSentAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  return (
    <View style={{ paddingVertical: spacing.xs, gap: 2 }}>
      <Text style={{ color: colors.text, fontSize: 14 }}>
        {describeReportSchedule(n)}
        {n.enabled ? "" : " · paused"}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>To {describeReportTargets(n)}</Text>
      <Text style={{ color: failed ? colors.danger : colors.textMuted, fontSize: 12 }}>
        {status}
        {lastSent && !failed ? ` · last sent ${lastSent}` : ""}
      </Text>
      {n.lastError ? (
        <Text style={{ color: colors.danger, fontSize: 12 }}>{n.lastError}</Text>
      ) : null}
    </View>
  );
}

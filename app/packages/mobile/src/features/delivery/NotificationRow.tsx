import { Text, View } from "react-native";
import {
  describeReportSchedule,
  describeReportTargets,
  type DashboardNotification,
  type ReportNotification,
} from "@infrawrench/client-core";
import { colors, spacing } from "@/lib/theme";

const STATUS_LABELS: Record<string, string> = {
  pending: "Sending…",
  succeeded: "Delivered",
  partial: "Partially delivered",
  failed: "Failed",
  no_targets: "No live destinations",
};

/**
 * One delivery schedule, read-only: when it fires, where it goes, how the
 * last send went. Shared by the cost report and dashboard screens; a
 * dashboard schedule is the same row pointed at a dashboard, plus whether the
 * rendered PDF rides along.
 */
export function NotificationRow({
  notification: n,
}: {
  notification: ReportNotification | DashboardNotification;
}) {
  const failed =
    n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets";
  const status = n.lastStatus ? (STATUS_LABELS[n.lastStatus] ?? n.lastStatus) : "Not sent yet";
  const lastSent = n.lastSentAt
    ? new Date(n.lastSentAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const pdfAttached = "attachPdf" in n && n.attachPdf;
  return (
    <View style={{ paddingVertical: spacing.xs, gap: 2 }}>
      <Text style={{ color: colors.text, fontSize: 14 }}>
        {describeReportSchedule(n)}
        {n.enabled ? "" : " · paused"}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        To {describeReportTargets(n)}
        {pdfAttached ? " · PDF attached" : ""}
      </Text>
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

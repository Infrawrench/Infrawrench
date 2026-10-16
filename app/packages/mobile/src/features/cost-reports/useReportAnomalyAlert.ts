import { useQuery } from "@tanstack/react-query";
import type { CostReportAnomalyAlert } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * One report's anomaly alert, read-only, or null when it has none.
 *
 * Read through the org-wide list so "no alert" is an empty answer rather than
 * a 404. Mobile shows the alert and its recent findings (a `cost_report_anomaly`
 * push lands on this screen) but does not edit it: an alert names Slack
 * channels, Teams webhooks, members and addresses, which belongs on web and
 * desktop next to the destination picker, like delivery schedules.
 */
export function useReportAnomalyAlert(reportId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["report-anomaly-alert", orgId, reportId],
    enabled: !!reportId,
    queryFn: async () => {
      const res = await api.org<{ alerts: CostReportAnomalyAlert[] }>(
        orgId,
        "/cost-report-anomaly-alerts",
      );
      return res?.alerts.find((a) => a.reportId === reportId) ?? null;
    },
  });
}

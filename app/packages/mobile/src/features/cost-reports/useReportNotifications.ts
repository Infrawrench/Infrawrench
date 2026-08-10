import { useQuery } from "@tanstack/react-query";
import type { ReportNotification } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * One report's delivery schedules, read-only.
 *
 * Mobile shows schedules and their last-send status but deliberately cannot
 * create or edit them: a schedule names Slack channels, Teams webhooks and an
 * email list — org-egress decisions (`org:settings:write` on the server) that
 * belong on web/desktop next to the pickers that make them safe. The same
 * stance as report editing itself.
 */
export function useReportNotifications(reportId: string | undefined, enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["report-notifications", orgId, reportId],
    enabled: enabled && !!reportId,
    queryFn: async () =>
      (await api.org<ReportNotification[]>(
        orgId,
        `/cost-reports/${encodeURIComponent(reportId!)}/notifications`,
      )) ?? [],
  });
}

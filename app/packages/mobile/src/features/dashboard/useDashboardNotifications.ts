import { useQuery } from "@tanstack/react-query";
import type { DashboardNotification } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * One dashboard's delivery schedules, read-only. Same stance as
 * `useReportNotifications`: mobile shows schedules and their last-send status,
 * and creating or editing them (Slack channels, Teams webhooks, email lists)
 * stays on web/desktop next to the pickers.
 */
export function useDashboardNotifications(dashboardId: string | undefined, enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["dashboard-notifications", orgId, dashboardId],
    enabled: enabled && !!dashboardId,
    queryFn: async () =>
      (await api.org<DashboardNotification[]>(
        orgId,
        `/dashboards/${encodeURIComponent(dashboardId!)}/notifications`,
      )) ?? [],
  });
}

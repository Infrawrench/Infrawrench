import {
  pdfFileName,
  withPdfTimezone,
  type DashboardNotification,
  type DashboardNotificationInput,
  type DashboardNotificationSendResult,
  type ReportDeliveryTargets,
} from "@infrawrench/client-core";
import { downloadBlob, type DashboardExportClient } from "@infrawrench/ui";
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPut } from "./api";

/**
 * The dashboard header's PDF export and scheduled delivery, over the
 * org-scoped dashboard routes.
 *
 * Reads (the PDF, the schedule list) are `dashboards:read`. The manage half is
 * `org:settings:write` server-side (email recipients are data egress, the
 * same reasoning as report delivery), so `canManage` false omits it and the
 * schedule dialog renders read-only instead of offering buttons that 403.
 */
export function createWebDashboardExportClient(
  orgId: string,
  canManage: boolean,
): DashboardExportClient {
  const base = `/api/org/${orgId}/dashboards`;
  const read: DashboardExportClient = {
    downloadPdf: async (dashboardId: string, dashboardName: string) => {
      const blob = await apiGetBlob(withPdfTimezone(`${base}/${dashboardId}/pdf`));
      downloadBlob(blob, pdfFileName(dashboardName, "dashboard"));
    },
    listNotifications: (dashboardId: string) =>
      apiGet<DashboardNotification[]>(`${base}/${dashboardId}/notifications`),
  };
  if (!canManage) return read;
  return {
    ...read,
    listDeliveryTargets: (dashboardId: string) =>
      apiGet<ReportDeliveryTargets>(`${base}/${dashboardId}/notifications/targets`),
    createNotification: (dashboardId: string, input: DashboardNotificationInput) =>
      apiPost<DashboardNotification>(`${base}/${dashboardId}/notifications`, input),
    updateNotification: (
      dashboardId: string,
      notificationId: string,
      input: DashboardNotificationInput,
    ) =>
      apiPut<DashboardNotification>(
        `${base}/${dashboardId}/notifications/${notificationId}`,
        input,
      ),
    deleteNotification: async (dashboardId: string, notificationId: string) => {
      await apiDelete(`${base}/${dashboardId}/notifications/${notificationId}`);
    },
    sendNotificationNow: (dashboardId: string, notificationId: string) =>
      apiPost<DashboardNotificationSendResult>(
        `${base}/${dashboardId}/notifications/${notificationId}/send`,
        {},
      ),
  };
}

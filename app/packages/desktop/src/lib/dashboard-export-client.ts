import { pdfFileName, type DashboardNotificationInput } from "@infrawrench/client-core";
import { downloadPdfBytes, type DashboardExportClient } from "@infrawrench/ui";
import {
  createCloudDashboardNotification,
  deleteCloudDashboardNotification,
  listCloudDashboardNotifications,
  loadCloudDashboardDeliveryTargets,
  loadCloudDashboardPdf,
  sendCloudDashboardNotificationNow,
  updateCloudDashboardNotification,
} from "./cloud-costs";

/**
 * The dashboard header's PDF export and scheduled delivery, cloud mode only:
 * the PDF is rendered server-side and a local dashboard has no server.
 *
 * Same server permissions as web (reads dashboards:read, writes
 * org:settings:write). `canManage` false omits the mutating half so the
 * schedule dialog renders read-only; the caller passes true while the
 * member's permissions are still unknown and lets a 403 surface as the
 * action's error rather than hiding controls from an admin.
 */
export function createDesktopDashboardExportClient(
  orgId: string,
  canManage: boolean,
): DashboardExportClient {
  const read: DashboardExportClient = {
    downloadPdf: async (dashboardId: string, dashboardName: string) => {
      const bytes = await loadCloudDashboardPdf(orgId, dashboardId);
      downloadPdfBytes(bytes, pdfFileName(dashboardName, "dashboard"));
    },
    listNotifications: (dashboardId: string) => listCloudDashboardNotifications(orgId, dashboardId),
  };
  if (!canManage) return read;
  return {
    ...read,
    listDeliveryTargets: (dashboardId: string) =>
      loadCloudDashboardDeliveryTargets(orgId, dashboardId),
    createNotification: (dashboardId: string, input: DashboardNotificationInput) =>
      createCloudDashboardNotification(orgId, dashboardId, input),
    updateNotification: (
      dashboardId: string,
      notificationId: string,
      input: DashboardNotificationInput,
    ) => updateCloudDashboardNotification(orgId, dashboardId, notificationId, input),
    deleteNotification: (dashboardId: string, notificationId: string) =>
      deleteCloudDashboardNotification(orgId, dashboardId, notificationId),
    sendNotificationNow: (dashboardId: string, notificationId: string) =>
      sendCloudDashboardNotificationNow(orgId, dashboardId, notificationId),
  };
}

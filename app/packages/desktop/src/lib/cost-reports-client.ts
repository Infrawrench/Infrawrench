import type { CostsPanelDashboard } from "@infrawrench/ui/cost";
import type { CostReportsClient } from "@infrawrench/ui/cost-reports";
import type {
  CostReportFolderInput,
  CostReportInput,
  ReportNotificationInput,
} from "@infrawrench/client-core";
import {
  createCloudCostReport,
  createCloudCostReportFolder,
  createCloudReportNotification,
  createCloudWidget,
  deleteCloudCostReport,
  deleteCloudCostReportFolder,
  deleteCloudReportNotification,
  deleteCloudWidget,
  getCloudCostReport,
  listCloudCostReportFolders,
  listCloudCostReports,
  listCloudReportNotifications,
  loadCloudReportDeliveryTargets,
  sendCloudReportNotificationNow,
  updateCloudCostReport,
  updateCloudCostReportFolder,
  updateCloudReportNotification,
} from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";
import { createDesktopCostApi, requireCloudOrgId as requireOrgId } from "./cost-api";

/**
 * The Cost reports client: the shared read calls plus report and folder CRUD,
 * the dashboard-placement calls for `cost_report` cards, and delivery
 * schedules.
 *
 * The reads come from {@link createDesktopCostApi} rather than being restated
 * here — the report editor is the same `CostGraphConfigModal` the dashboard and
 * the Costs panel open, so it must be handed the same loaders or its scenario,
 * saved-filter and unit-cost pickers quietly disappear.
 */
export function createDesktopCostReportsClient(): CostReportsClient {
  return {
    ...createDesktopCostApi(),
    listReports: () => listCloudCostReports(requireOrgId()),
    getReport: (reportId: string) => getCloudCostReport(requireOrgId(), reportId),
    createReport: (input: CostReportInput) => createCloudCostReport(requireOrgId(), input),
    updateReport: (reportId: string, input: CostReportInput) =>
      updateCloudCostReport(requireOrgId(), reportId, input),
    deleteReport: (reportId: string) => deleteCloudCostReport(requireOrgId(), reportId),
    listFolders: () => listCloudCostReportFolders(requireOrgId()),
    createFolder: (input: CostReportFolderInput) =>
      createCloudCostReportFolder(requireOrgId(), input),
    updateFolder: (folderId: string, input: CostReportFolderInput) =>
      updateCloudCostReportFolder(requireOrgId(), folderId, input),
    deleteFolder: (folderId: string) => deleteCloudCostReportFolder(requireOrgId(), folderId),
    listDashboards: async (): Promise<CostsPanelDashboard[]> => {
      const rows = await listCloudDashboards(requireOrgId());
      return rows.map((d) => ({ id: d.id, name: d.name }));
    },
    addReportToDashboard: async (dashboardId: string, reportId: string, title: string) => {
      await createCloudWidget(requireOrgId(), {
        dashboardId,
        kind: "cost_report",
        title,
        config: { version: 1, reportId },
      });
    },
    removeReportPlacement: (widgetId: string) => deleteCloudWidget(requireOrgId(), widgetId),
    // Delivery schedules — same server permissions as web (reads costs:read,
    // writes org:settings:write); a 403 surfaces as the action's error.
    listReportNotifications: (reportId: string) =>
      listCloudReportNotifications(requireOrgId(), reportId),
    listReportDeliveryTargets: (reportId: string) =>
      loadCloudReportDeliveryTargets(requireOrgId(), reportId),
    createReportNotification: (reportId: string, input: ReportNotificationInput) =>
      createCloudReportNotification(requireOrgId(), reportId, input),
    updateReportNotification: (
      reportId: string,
      notificationId: string,
      input: ReportNotificationInput,
    ) => updateCloudReportNotification(requireOrgId(), reportId, notificationId, input),
    deleteReportNotification: (reportId: string, notificationId: string) =>
      deleteCloudReportNotification(requireOrgId(), reportId, notificationId),
    sendReportNotificationNow: (reportId: string, notificationId: string) =>
      sendCloudReportNotificationNow(requireOrgId(), reportId, notificationId),
  };
}

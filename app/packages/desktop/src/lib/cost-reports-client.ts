import type { CostsPanelDashboard } from "@infrawrench/ui/cost";
import { createSharingClient, type SharingClient } from "@infrawrench/ui";
import { createDesktopSettingsApi } from "./settings-client";
import type { CostReportsClient } from "@infrawrench/ui/cost-reports";
import {
  pdfFileName,
  type CostReportFolderInput,
  type CostReportInput,
  type ReportNotificationInput,
} from "@infrawrench/client-core";
import { downloadPdfBytes } from "@infrawrench/ui";
import {
  loadCloudCostReportPdf,
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
 * here: the report editor is the same `CostGraphConfigModal` the dashboard and
 * the Costs panel open, so it must be handed the same loaders or its scenario,
 * saved-filter and unit-cost pickers quietly disappear.
 */
export function createDesktopCostReportsClient(): CostReportsClient {
  return {
    ...createDesktopCostApi(),
    sharing: createDesktopSharingClient(),
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
    // Delivery schedules: same server permissions as web (reads costs:read,
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
    downloadReportPdf: async (reportId: string, reportName: string) => {
      const bytes = await loadCloudCostReportPdf(requireOrgId(), reportId);
      downloadPdfBytes(bytes, pdfFileName(reportName));
    },
  };
}

/**
 * Object sharing over the allowlisted `cloud_settings_request` channel
 * (`/sharing` and the Team reads are on its allowlist). The org is resolved
 * per call, like every other desktop cost client.
 */
export function createDesktopSharingClient(): SharingClient {
  const api = createDesktopSettingsApi();
  const forOrg = () =>
    createSharingClient(requireOrgId(), {
      get: <T>(path: string) => api.get<T>(path),
      put: <T>(path: string, body: unknown) => api.put<T>(path, body),
    });
  return {
    get: (type, id) => forOrg().get(type, id),
    put: (type, id, input) => forOrg().put(type, id, input),
    listMembers: () => forOrg().listMembers(),
    listRoles: () => forOrg().listRoles(),
  };
}

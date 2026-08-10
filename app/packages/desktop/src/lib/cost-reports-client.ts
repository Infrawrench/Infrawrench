import { useUIStore } from "@infrawrench/ui";
import type { CostsPanelDashboard } from "@infrawrench/ui/cost";
import type { CostReportsClient } from "@infrawrench/ui/cost-reports";
import type { CostReportInput } from "@infrawrench/client-core";
import {
  createCloudCostReport,
  createCloudWidget,
  deleteCloudCostReport,
  deleteCloudWidget,
  getCloudCostReport,
  listCloudCostReports,
  loadCloudCostDimensionValues,
  loadCloudCostStatus,
  queryCloudCosts,
  updateCloudCostReport,
} from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";

/**
 * Cost reports are cloud-only for the same reason budgets are: the spend they
 * draw is collected server-side, so a desktop app in local mode has nothing to
 * report on. Every call resolves the active org at call time rather than
 * closing over it — the org can change under a mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Cost reports require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopCostReportsClient(): CostReportsClient {
  return {
    queryCosts: (req) => queryCloudCosts(requireOrgId(), req),
    loadDimensionValues: (dimension, tagKey) => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return loadCloudCostDimensionValues(orgId, dimension, tagKey);
    },
    loadCostStatus: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return loadCloudCostStatus(orgId);
    },
    // The report editor is the shared CostGraphConfigModal, so it offers the
    // saved-filter picker; management lives on the Costs panel.
    listSavedFilters: () => listCloudSavedCostFilters(requireOrgId()),
    createSavedFilter: (input: SavedCostFilterInput) =>
      createCloudSavedCostFilter(requireOrgId(), input),
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
  };
}

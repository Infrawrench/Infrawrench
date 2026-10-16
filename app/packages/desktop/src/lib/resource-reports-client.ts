import { useUIStore } from "@infrawrench/ui";
import type { ResourceReportsClient } from "@infrawrench/ui/resource-reports";
import type {
  CostReportFolder,
  ResourceReport,
  ResourceReportOptions,
  ResourceReportRowsResult,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";
import { createCloudCostReportFolder } from "./cloud-costs";
import { createDesktopSharingClient } from "./cost-reports-client";

/**
 * Resource reports are cloud-only: the rows are a server-side join of the
 * synced inventory with the cost store. The active org is resolved at call
 * time, not closed over, because the org can change under a mounted panel.
 * Every method is offered; the server enforces `resources:write` and
 * `costs:write` (folders) and the panel shows its error.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Resource reports require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopResourceReportsClient(): ResourceReportsClient {
  return {
    sharing: createDesktopSharingClient(),
    listReports: () =>
      invoke<ResourceReport[]>("cloud_resource_reports_list", { orgId: requireOrgId() }),
    getReport: (reportId) =>
      invoke<ResourceReport>("cloud_resource_reports_get", { orgId: requireOrgId(), reportId }),
    listFolders: () =>
      invoke<CostReportFolder[]>("cloud_resource_reports_folders", { orgId: requireOrgId() }),
    getOptions: (types) =>
      invoke<ResourceReportOptions>("cloud_resource_reports_options", {
        orgId: requireOrgId(),
        types: (types ?? []).map((t) => `${t.pluginId}/${t.resourceTypeId}`).join(","),
      }),
    getTagValues: async (source, key) =>
      (
        await invoke<{ values: string[] }>("cloud_resource_reports_tag_values", {
          orgId: requireOrgId(),
          source,
          key,
        })
      ).values,
    query: (request) =>
      invoke<ResourceReportRowsResult>("cloud_resource_reports_query", {
        orgId: requireOrgId(),
        request,
      }),
    exportCsv: (config, name) =>
      invoke<string>("cloud_resource_reports_csv", { orgId: requireOrgId(), config, name }),
    createReport: (input) =>
      invoke<ResourceReport>("cloud_resource_reports_create", { orgId: requireOrgId(), input }),
    updateReport: (reportId, input) =>
      invoke<ResourceReport>("cloud_resource_reports_update", {
        orgId: requireOrgId(),
        reportId,
        input,
      }),
    deleteReport: async (reportId) => {
      await invoke("cloud_resource_reports_delete", { orgId: requireOrgId(), reportId });
    },
    createFolder: (input) => createCloudCostReportFolder(requireOrgId(), input),
  };
}

import type { ResourceReportsClient } from "@infrawrench/ui/resource-reports";
import type {
  CostReportFolder,
  CostReportFolderInput,
  ResourceReport,
  ResourceReportInput,
  ResourceReportOptions,
  ResourceReportRowsResult,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPostText, apiPut } from "./api";
import { createWebSharingClient } from "./cost-client";

/**
 * Web implementation of the shared resource reports client, per org.
 * `canWrite` gates the writes (`resources:write`) and `canWriteFolders` the
 * folder creation (`costs:write`, the folder tree's own permission); without
 * them the panel offers no Save or New folder, and the server enforces either
 * way.
 */
export function createWebResourceReportsClient(
  orgId: string,
  canWrite = true,
  canWriteFolders = false,
): ResourceReportsClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/resource-reports`;
  const id = (reportId: string) => `${base}/${encodeURIComponent(reportId)}`;
  return {
    sharing: createWebSharingClient(orgId),
    listReports: () => apiGet<ResourceReport[]>(base),
    getReport: (reportId) => apiGet<ResourceReport>(id(reportId)),
    listFolders: () => apiGet<CostReportFolder[]>(`${base}/folders`),
    getOptions: (types) => {
      const list = (types ?? []).map((t) => `${t.pluginId}/${t.resourceTypeId}`).join(",");
      return apiGet<ResourceReportOptions>(
        `${base}/options${list ? `?types=${encodeURIComponent(list)}` : ""}`,
      );
    },
    getTagValues: async (source, key) =>
      (
        await apiGet<{ values: string[] }>(
          `${base}/tag-values?source=${source}&key=${encodeURIComponent(key)}`,
        )
      ).values,
    query: (request) => apiPost<ResourceReportRowsResult>(`${base}/query`, request),
    exportCsv: (config, name) => apiPostText(`${base}/csv`, { config, name }),
    ...(canWrite
      ? {
          createReport: (input: ResourceReportInput) => apiPost<ResourceReport>(base, input),
          updateReport: (reportId: string, input: ResourceReportInput) =>
            apiPut<ResourceReport>(id(reportId), input),
          deleteReport: async (reportId: string) => {
            await apiDelete(id(reportId));
          },
        }
      : {}),
    ...(canWriteFolders
      ? {
          createFolder: (input: CostReportFolderInput) =>
            apiPost<CostReportFolder>(
              `/api/org/${encodeURIComponent(orgId)}/cost-report-folders`,
              input,
            ),
        }
      : {}),
  };
}

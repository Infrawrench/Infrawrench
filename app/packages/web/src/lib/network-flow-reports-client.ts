import type { NetworkFlowReportsClient } from "@infrawrench/ui";
import type {
  CostReportFolder,
  NetworkFlowReport,
  NetworkFlowReportInput,
  NetworkFlowReportOptions,
  NetworkFlowReportRunResult,
} from "@infrawrench/client-core";

import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { createWebSharingClient } from "./cost-client";

/**
 * Saved network flow reports over cookie-authenticated fetch. The write calls
 * are always wired: a caller without `costs:write` sees the server's 403 as
 * the action's error, as with cost reports.
 */
export function createWebNetworkFlowReportsClient(orgId: string): NetworkFlowReportsClient {
  const base = `/api/org/${orgId}/network-flows`;
  const reportPath = (reportId: string) => `${base}/reports/${encodeURIComponent(reportId)}`;
  return {
    listReports: () => apiGet<NetworkFlowReport[]>(`${base}/reports`),
    runReport: (reportId: string) =>
      apiPost<NetworkFlowReportRunResult>(`${reportPath(reportId)}/run`, {}),
    getOptions: () => apiGet<NetworkFlowReportOptions>(`${base}/report-options`),
    listFolders: () => apiGet<CostReportFolder[]>(`/api/org/${orgId}/cost-report-folders`),
    createReport: (input: NetworkFlowReportInput) =>
      apiPost<NetworkFlowReport>(`${base}/reports`, input),
    updateReport: (reportId: string, input: NetworkFlowReportInput) =>
      apiPut<NetworkFlowReport>(reportPath(reportId), input),
    deleteReport: async (reportId: string) => {
      await apiDelete(reportPath(reportId));
    },
    sharing: createWebSharingClient(orgId),
  };
}

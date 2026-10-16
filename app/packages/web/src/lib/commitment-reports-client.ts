import type { CommitmentReportsClient } from "@infrawrench/ui";
import type {
  CommitmentReport,
  CommitmentReportInput,
  CommitmentReportOptions,
  CommitmentReportRunResult,
  CostReportFolder,
} from "@infrawrench/client-core";

import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { createWebSharingClient } from "./cost-client";

/**
 * Saved commitment reports over cookie-authenticated fetch. The write calls
 * are always wired: a caller without `costs:write` sees the server's 403 as
 * the action's error, as with cost reports.
 */
export function createWebCommitmentReportsClient(orgId: string): CommitmentReportsClient {
  const base = `/api/org/${orgId}/commitments`;
  return {
    listReports: () => apiGet<CommitmentReport[]>(`${base}/reports`),
    runReport: (reportId: string) =>
      apiPost<CommitmentReportRunResult>(`${base}/reports/${encodeURIComponent(reportId)}/run`, {}),
    getOptions: () => apiGet<CommitmentReportOptions>(`${base}/report-options`),
    listFolders: () => apiGet<CostReportFolder[]>(`/api/org/${orgId}/cost-report-folders`),
    createReport: (input: CommitmentReportInput) =>
      apiPost<CommitmentReport>(`${base}/reports`, input),
    updateReport: (reportId: string, input: CommitmentReportInput) =>
      apiPut<CommitmentReport>(`${base}/reports/${encodeURIComponent(reportId)}`, input),
    deleteReport: async (reportId: string) => {
      await apiDelete(`${base}/reports/${encodeURIComponent(reportId)}`);
    },
    sharing: createWebSharingClient(orgId),
  };
}

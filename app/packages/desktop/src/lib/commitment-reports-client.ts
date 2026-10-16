import type { CommitmentReportsClient } from "@infrawrench/ui";
import type {
  CommitmentReport,
  CommitmentReportInput,
  CommitmentReportOptions,
  CommitmentReportRunResult,
} from "@infrawrench/client-core";

import { listCloudCostReportFolders } from "./cloud-costs";
import { requireCloudOrgId as requireOrgId } from "./cost-api";
import { createDesktopSharingClient } from "./cost-reports-client";
import { invoke } from "./invoke";

/**
 * Saved commitment reports over the allowlisted `cloud_commitment_report*`
 * channels (cloud mode only). The org is resolved per call, like every other
 * desktop cost client, so a sign-out mid-session fails loudly rather than
 * reading the previous org.
 */
export function createDesktopCommitmentReportsClient(): CommitmentReportsClient {
  return {
    listReports: () =>
      invoke<CommitmentReport[]>("cloud_commitment_reports", { orgId: requireOrgId() }),
    runReport: (reportId: string) =>
      invoke<CommitmentReportRunResult>("cloud_commitment_report_run", {
        orgId: requireOrgId(),
        reportId,
      }),
    getOptions: () =>
      invoke<CommitmentReportOptions>("cloud_commitment_report_options", {
        orgId: requireOrgId(),
      }),
    listFolders: () => listCloudCostReportFolders(requireOrgId()),
    createReport: (input: CommitmentReportInput) =>
      invoke<CommitmentReport>("cloud_commitment_report_create", { orgId: requireOrgId(), input }),
    updateReport: (reportId: string, input: CommitmentReportInput) =>
      invoke<CommitmentReport>("cloud_commitment_report_update", {
        orgId: requireOrgId(),
        reportId,
        input,
      }),
    deleteReport: async (reportId: string) => {
      await invoke("cloud_commitment_report_delete", { orgId: requireOrgId(), reportId });
    },
    sharing: createDesktopSharingClient(),
  };
}

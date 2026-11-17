import type { CommitmentReportsClient } from "@infrawrench/ui";
import type {
  CommitmentReport,
  CommitmentReportInput,
  CommitmentReportOptions,
  CommitmentReportRunResult,
} from "@infrawrench/client-core";

import { listCloudCostReportFolders } from "./cloud-costs";
import { definedFields } from "./cloud-payload";
import { requireCloudOrgId as requireOrgId } from "./cost-api";
import { createDesktopSharingClient } from "./cost-reports-client";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const commitmentReports = () => cloudClient("commitments").commitmentReports;

/**
 * Saved commitment reports over the cloud transport (cloud mode only). The
 * org is resolved per call, like every other desktop cost client, so a
 * sign-out mid-session fails loudly rather than reading the previous org.
 */
export function createDesktopCommitmentReportsClient(): CommitmentReportsClient {
  return {
    listReports: (): Promise<CommitmentReport[]> =>
      runRpc(commitmentReports().listReports({ params: { orgId: requireOrgId() } })),
    runReport: (reportId: string): Promise<CommitmentReportRunResult> =>
      runRpc(commitmentReports().runReport({ params: { orgId: requireOrgId(), id: reportId } })),
    getOptions: (): Promise<CommitmentReportOptions> =>
      runRpc(commitmentReports().reportOptions({ params: { orgId: requireOrgId() } })),
    listFolders: () => listCloudCostReportFolders(requireOrgId()),
    createReport: (input: CommitmentReportInput): Promise<CommitmentReport> =>
      runRpc(
        commitmentReports().createReport({
          params: { orgId: requireOrgId() },
          payload: definedFields(input),
        }),
      ),
    updateReport: (reportId: string, input: CommitmentReportInput): Promise<CommitmentReport> =>
      runRpc(
        commitmentReports().updateReport({
          params: { orgId: requireOrgId(), id: reportId },
          payload: definedFields(input),
        }),
      ),
    deleteReport: async (reportId: string) => {
      await runRpc(
        commitmentReports().deleteReport({ params: { orgId: requireOrgId(), id: reportId } }),
      );
    },
    sharing: createDesktopSharingClient(),
  };
}

import type { NetworkFlowReportsClient } from "@infrawrench/ui";
import type {
  NetworkFlowReport,
  NetworkFlowReportInput,
  NetworkFlowReportOptions,
  NetworkFlowReportRunResult,
} from "@infrawrench/client-core";

import { listCloudCostReportFolders } from "./cloud-costs";
import { requireCloudOrgId as requireOrgId } from "./cost-api";
import { createDesktopSharingClient } from "./cost-reports-client";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const networkFlows = () => cloudClient("networkFlows").networkFlows;

/**
 * Saved network flow reports over the cloud transport (cloud mode only). The org is resolved per call, like every other
 * desktop cost client, so a sign-out mid-session fails loudly rather than
 * reading the previous org.
 */
export function createDesktopNetworkFlowReportsClient(): NetworkFlowReportsClient {
  return {
    listReports: (): Promise<NetworkFlowReport[]> =>
      runRpc(networkFlows().listReports({ params: { orgId: requireOrgId() } })),
    runReport: (reportId: string): Promise<NetworkFlowReportRunResult> =>
      runRpc(networkFlows().runReport({ params: { orgId: requireOrgId(), id: reportId } })),
    getOptions: (): Promise<NetworkFlowReportOptions> =>
      runRpc(networkFlows().reportOptions({ params: { orgId: requireOrgId() } })),
    listFolders: () => listCloudCostReportFolders(requireOrgId()),
    createReport: (input: NetworkFlowReportInput): Promise<NetworkFlowReport> =>
      runRpc(networkFlows().createReport({ params: { orgId: requireOrgId() }, payload: input })),
    updateReport: (reportId: string, input: NetworkFlowReportInput): Promise<NetworkFlowReport> =>
      runRpc(
        networkFlows().updateReport({
          params: { orgId: requireOrgId(), id: reportId },
          payload: input,
        }),
      ),
    deleteReport: async (reportId: string) => {
      await runRpc(
        networkFlows().deleteReport({ params: { orgId: requireOrgId(), id: reportId } }),
      );
    },
    sharing: createDesktopSharingClient(),
  };
}

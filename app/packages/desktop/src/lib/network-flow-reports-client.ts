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
import { invoke } from "./invoke";

/**
 * Saved network flow reports over the allowlisted `cloud_network_flow_report*`
 * channels (cloud mode only). The org is resolved per call, like every other
 * desktop cost client, so a sign-out mid-session fails loudly rather than
 * reading the previous org.
 */
export function createDesktopNetworkFlowReportsClient(): NetworkFlowReportsClient {
  return {
    listReports: () =>
      invoke<NetworkFlowReport[]>("cloud_network_flow_reports", { orgId: requireOrgId() }),
    runReport: (reportId: string) =>
      invoke<NetworkFlowReportRunResult>("cloud_network_flow_report_run", {
        orgId: requireOrgId(),
        reportId,
      }),
    getOptions: () =>
      invoke<NetworkFlowReportOptions>("cloud_network_flow_report_options", {
        orgId: requireOrgId(),
      }),
    listFolders: () => listCloudCostReportFolders(requireOrgId()),
    createReport: (input: NetworkFlowReportInput) =>
      invoke<NetworkFlowReport>("cloud_network_flow_report_create", {
        orgId: requireOrgId(),
        input,
      }),
    updateReport: (reportId: string, input: NetworkFlowReportInput) =>
      invoke<NetworkFlowReport>("cloud_network_flow_report_update", {
        orgId: requireOrgId(),
        reportId,
        input,
      }),
    deleteReport: async (reportId: string) => {
      await invoke("cloud_network_flow_report_delete", { orgId: requireOrgId(), reportId });
    },
    sharing: createDesktopSharingClient(),
  };
}

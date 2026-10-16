/**
 * The desktop Kubernetes efficiency client (cloud mode): report calls over
 * the `cloud_k8s_efficiency_*` IPC channels (electron/cloud-data/k8s-efficiency.ts),
 * folders over the cost-report folder channel and sharing over the
 * allowlisted settings channel. Built per org, like the Canvases client.
 */
import type {
  CostReportFolder,
  KubernetesEfficiencyConfig,
  KubernetesEfficiencyReport,
  KubernetesEfficiencyReportInput,
  KubernetesEfficiencyResult,
  KubernetesEfficiencyRunResult,
} from "@infrawrench/client-core";
import type {
  KubernetesEfficiencyClient,
  KubernetesEfficiencyOptions,
} from "@infrawrench/ui/k8s-efficiency";
import { invoke } from "./invoke";
import { listCloudCostReportFolders } from "./cloud-costs";
import { createDesktopSharingClient } from "./cost-reports-client";

export function createDesktopKubernetesEfficiencyClient(orgId: string): KubernetesEfficiencyClient {
  return {
    sharing: createDesktopSharingClient(),
    listReports: async () =>
      (await invoke<KubernetesEfficiencyReport[]>("cloud_k8s_efficiency_list", { orgId })) ?? [],
    getReport: (reportId: string) =>
      invoke<KubernetesEfficiencyReport>("cloud_k8s_efficiency_get", { orgId, reportId }),
    runReport: (reportId: string) =>
      invoke<KubernetesEfficiencyRunResult>("cloud_k8s_efficiency_run", { orgId, reportId }),
    query: (config: KubernetesEfficiencyConfig) =>
      invoke<KubernetesEfficiencyResult>("cloud_k8s_efficiency_query", { orgId, config }),
    getOptions: () =>
      invoke<KubernetesEfficiencyOptions>("cloud_k8s_efficiency_options", { orgId }),
    getTagValues: async (tagKey: string) =>
      (await invoke<{ values: string[] }>("cloud_k8s_efficiency_values", { orgId, tagKey }))
        ?.values ?? [],
    listFolders: async () => (await listCloudCostReportFolders(orgId)) as CostReportFolder[],
    createReport: (input: KubernetesEfficiencyReportInput) =>
      invoke<KubernetesEfficiencyReport>("cloud_k8s_efficiency_create", { orgId, input }),
    updateReport: (reportId: string, input: KubernetesEfficiencyReportInput) =>
      invoke<KubernetesEfficiencyReport>("cloud_k8s_efficiency_update", { orgId, reportId, input }),
    deleteReport: async (reportId: string) => {
      await invoke("cloud_k8s_efficiency_delete", { orgId, reportId });
    },
  };
}

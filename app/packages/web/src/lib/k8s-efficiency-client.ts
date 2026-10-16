/**
 * The web Kubernetes efficiency client: report CRUD, run, preview, pickers,
 * cost-report folders and sharing, over cookie-authenticated fetch.
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
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { createWebSharingClient } from "./cost-client";

export function createWebKubernetesEfficiencyClient(orgId: string): KubernetesEfficiencyClient {
  const base = `/api/org/${orgId}/k8s-efficiency-reports`;
  const enc = encodeURIComponent;
  return {
    sharing: createWebSharingClient(orgId),
    listReports: () => apiGet<KubernetesEfficiencyReport[]>(base),
    getReport: (reportId: string) => apiGet<KubernetesEfficiencyReport>(`${base}/${enc(reportId)}`),
    runReport: (reportId: string) =>
      apiPost<KubernetesEfficiencyRunResult>(`${base}/${enc(reportId)}/run`, {}),
    query: (config: KubernetesEfficiencyConfig) =>
      apiPost<KubernetesEfficiencyResult>(`${base}/query`, { config }),
    getOptions: () => apiGet<KubernetesEfficiencyOptions>(`${base}/options`),
    getTagValues: async (tagKey: string) =>
      (await apiGet<{ values: string[] }>(`${base}/values?tagKey=${enc(tagKey)}`)).values,
    listFolders: () => apiGet<CostReportFolder[]>(`/api/org/${orgId}/cost-report-folders`),
    createReport: (input: KubernetesEfficiencyReportInput) =>
      apiPost<KubernetesEfficiencyReport>(base, input),
    updateReport: (reportId: string, input: KubernetesEfficiencyReportInput) =>
      apiPut<KubernetesEfficiencyReport>(`${base}/${enc(reportId)}`, input),
    deleteReport: async (reportId: string) => {
      await apiDelete(`${base}/${enc(reportId)}`);
    },
  };
}

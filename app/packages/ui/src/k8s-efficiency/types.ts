import type {
  CostReportFolder,
  CostTagKeyDescription,
  CostTagKeyGroup,
  KubernetesEfficiencyConfig,
  KubernetesEfficiencyReport,
  KubernetesEfficiencyReportInput,
  KubernetesEfficiencyResult,
  KubernetesEfficiencyRunResult,
} from "@infrawrench/client-core";
import type { SharingClient } from "../sharing/ShareDialog.js";

/** What the editor's pickers offer (`GET /k8s-efficiency-reports/options`). */
export interface KubernetesEfficiencyOptions {
  clusters: Array<{ id: string; name: string }>;
  regions: string[];
  namespaces: string[];
  nodePools: string[];
  labelKeys: Array<{ group: CostTagKeyGroup; keys: CostTagKeyDescription[] }>;
}

/**
 * Host-injected data access for the efficiency report components: web wraps
 * `apiFetch`, desktop its cloud IPC. The writes are optional, so a viewer
 * without `costs:write` gets a host that omits them and a read-only panel.
 */
export interface KubernetesEfficiencyClient {
  listReports(): Promise<KubernetesEfficiencyReport[]>;
  getReport(reportId: string): Promise<KubernetesEfficiencyReport>;
  runReport(reportId: string): Promise<KubernetesEfficiencyRunResult>;
  /** Run an unsaved config: the editor's preview. */
  query(config: KubernetesEfficiencyConfig): Promise<KubernetesEfficiencyResult>;
  getOptions(): Promise<KubernetesEfficiencyOptions>;
  /** Values of one label on Kubernetes rows, for a filter's value picker. */
  getTagValues(tagKey: string): Promise<string[]>;
  /** Cost-report folders, which these reports are filed in too. */
  listFolders?(): Promise<CostReportFolder[]>;
  createReport?(input: KubernetesEfficiencyReportInput): Promise<KubernetesEfficiencyReport>;
  updateReport?(
    reportId: string,
    input: KubernetesEfficiencyReportInput,
  ): Promise<KubernetesEfficiencyReport>;
  deleteReport?(reportId: string): Promise<void>;
  sharing?: SharingClient;
}

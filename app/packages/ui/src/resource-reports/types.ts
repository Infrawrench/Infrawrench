import type {
  CostReportFolder,
  CostReportFolderInput,
  ResourceReport,
  ResourceReportConfig,
  ResourceReportInput,
  ResourceReportOptions,
  ResourceReportQueryRequest,
  ResourceReportRowsResult,
  ResourceReportTagFilter,
  ResourceReportTypeRef,
} from "@infrawrench/client-core";
import type { SharingClient } from "../sharing/ShareDialog.js";

/**
 * Host-injected data access for resource reports: web wraps `apiFetch`,
 * desktop its cloud IPC, and nothing in here imports a platform primitive.
 *
 * The writes are optional: a viewer without `resources:write` gets a host
 * that omits them and the panel renders read-only (it can still change
 * columns and filters to explore, it just cannot save).
 */
export interface ResourceReportsClient {
  listReports(): Promise<ResourceReport[]>;
  getReport(reportId: string): Promise<ResourceReport>;
  /** The report folders (shared with cost reports) the caller can see. */
  listFolders(): Promise<CostReportFolder[]>;
  /** What the pickers offer; `types` narrows the metadata fields. */
  getOptions(types?: readonly ResourceReportTypeRef[]): Promise<ResourceReportOptions>;
  getTagValues(source: ResourceReportTagFilter["source"], key: string): Promise<string[]>;
  /** Run a config (saved or not): one page of rows. */
  query(request: ResourceReportQueryRequest): Promise<ResourceReportRowsResult>;
  /** Every row as CSV text; the panel hands it to the browser's download. */
  exportCsv(config: ResourceReportConfig, name: string): Promise<string>;
  createReport?(input: ResourceReportInput): Promise<ResourceReport>;
  updateReport?(reportId: string, input: ResourceReportInput): Promise<ResourceReport>;
  deleteReport?(reportId: string): Promise<void>;
  /** Folders are the cost reports' tree; omit to offer no "New folder". */
  createFolder?(input: CostReportFolderInput): Promise<CostReportFolder>;
  /** Per-object sharing; the Share action renders only when wired. */
  sharing?: SharingClient;
}

/** What a row click opens: the resource's detail view. */
export interface ResourceReportResourceRef {
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
}

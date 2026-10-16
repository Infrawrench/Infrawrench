import type {
  CostReportFolder,
  NetworkFlowReport,
  NetworkFlowReportInput,
  NetworkFlowReportOptions,
  NetworkFlowReportRunResult,
} from "@infrawrench/client-core";

import type { SharingClient } from "../sharing/ShareDialog.js";

/**
 * What the network flow reports section needs from its host: web over
 * cookie-authenticated fetch, desktop over its allowlisted IPC channels.
 *
 * The write calls are optional so a host (or a caller without `costs:write`
 * on a read-only surface) can leave them out and the section hides the
 * buttons rather than offering actions that fail. `listFolders` reads the
 * report-folder tree cost reports use: the kinds of report file into the same
 * folders, and folders are managed in Reports.
 */
export interface NetworkFlowReportsClient {
  listReports(): Promise<NetworkFlowReport[]>;
  runReport(reportId: string): Promise<NetworkFlowReportRunResult>;
  getOptions(): Promise<NetworkFlowReportOptions>;
  listFolders(): Promise<CostReportFolder[]>;
  createReport?(input: NetworkFlowReportInput): Promise<NetworkFlowReport>;
  updateReport?(reportId: string, input: NetworkFlowReportInput): Promise<NetworkFlowReport>;
  deleteReport?(reportId: string): Promise<void>;
  /** Per-object sharing; the Share action only appears when this is wired. */
  sharing?: SharingClient | undefined;
}

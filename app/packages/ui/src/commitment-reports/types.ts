import type {
  CommitmentReport,
  CommitmentReportInput,
  CommitmentReportOptions,
  CommitmentReportRunResult,
  CostReportFolder,
} from "@infrawrench/client-core";

import type { SharingClient } from "../sharing/ShareDialog.js";

/**
 * What the commitment reports section needs from its host: web over
 * cookie-authenticated fetch, desktop over its allowlisted IPC channels.
 *
 * The write calls are optional so a host (or a caller without `costs:write`
 * on a read-only surface) can leave them out and the section hides the
 * buttons rather than offering actions that fail. `listFolders` reads the
 * report-folder tree cost reports use: the two kinds of report file into the
 * same folders, and folders are managed in Reports.
 */
export interface CommitmentReportsClient {
  listReports(): Promise<CommitmentReport[]>;
  runReport(reportId: string): Promise<CommitmentReportRunResult>;
  getOptions(): Promise<CommitmentReportOptions>;
  listFolders(): Promise<CostReportFolder[]>;
  createReport?(input: CommitmentReportInput): Promise<CommitmentReport>;
  updateReport?(reportId: string, input: CommitmentReportInput): Promise<CommitmentReport>;
  deleteReport?(reportId: string): Promise<void>;
  /** Per-object sharing; the Share action only appears when this is wired. */
  sharing?: SharingClient | undefined;
}

import type {
  CostReport,
  CostReportFolder,
  CostReportFolderInput,
  CostReportInput,
  ReportDeliveryTargets,
  ReportNotification,
  ReportNotificationInput,
  ReportNotificationSendResult,
} from "@infrawrench/client-core";
import type { CostApi, CostsPanelDashboard } from "../cost/types.js";

/**
 * Host-injected data access for the cost-report components — the same shape
 * rule the cost components follow: web wraps `apiFetch`, desktop wraps its
 * cloud-api helpers, and nothing in here imports a platform primitive.
 *
 * The mutating half is optional. A viewer without `costs:write` gets a host
 * that omits it, and the views render read-only rather than showing controls
 * that fail on click — the same stance {@link CostsClient} takes on budgets.
 * `listFolders` sits with the reads: grouping the list is part of reading it.
 */
export interface CostReportsClient extends CostApi {
  listReports(): Promise<CostReport[]>;
  getReport(reportId: string): Promise<CostReport>;
  listFolders(): Promise<CostReportFolder[]>;
  createReport?(input: CostReportInput): Promise<CostReport>;
  updateReport?(reportId: string, input: CostReportInput): Promise<CostReport>;
  deleteReport?(reportId: string): Promise<void>;
  createFolder?(input: CostReportFolderInput): Promise<CostReportFolder>;
  /** Rename and/or reparent — the server rejects cycles and over-deep nesting. */
  updateFolder?(folderId: string, input: CostReportFolderInput): Promise<CostReportFolder>;
  /** Contents are not deleted with it — they fall back to the top level. */
  deleteFolder?(folderId: string): Promise<void>;
  /** Dashboards a report card can be added to, for the placement picker. */
  listDashboards?(): Promise<CostsPanelDashboard[]>;
  /** Add a `cost_report` card for `reportId` to `dashboardId`. */
  addReportToDashboard?(dashboardId: string, reportId: string, title: string): Promise<void>;
  /** Remove one card, identified by the widget id from `placements`. */
  removeReportPlacement?(widgetId: string): Promise<void>;
  /**
   * Delivery schedules for one report — sits with the reads (`costs:read`)
   * so the Delivery section can list schedules even for a viewer.
   */
  listReportNotifications?(reportId: string): Promise<ReportNotification[]>;
  /**
   * The mutating half of scheduled delivery. Server-side these are
   * `org:settings:write` (email recipients are spend egress, the cost-exports
   * reasoning), so hosts may include them and let the API answer 403, or omit
   * them to render the section read-only.
   */
  listReportDeliveryTargets?(reportId: string): Promise<ReportDeliveryTargets>;
  createReportNotification?(
    reportId: string,
    input: ReportNotificationInput,
  ): Promise<ReportNotification>;
  updateReportNotification?(
    reportId: string,
    notificationId: string,
    input: ReportNotificationInput,
  ): Promise<ReportNotification>;
  deleteReportNotification?(reportId: string, notificationId: string): Promise<void>;
  /** Run the report and deliver it to this schedule's destinations now. */
  sendReportNotificationNow?(
    reportId: string,
    notificationId: string,
  ): Promise<ReportNotificationSendResult>;
}

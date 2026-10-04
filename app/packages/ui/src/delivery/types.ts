import type {
  DashboardNotification,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
  ReportDeliveryTargets,
  ReportNotification,
  ReportNotificationInput,
  ReportNotificationSendResult,
} from "@infrawrench/client-core";

/**
 * A delivery schedule as the shared list renders it: a report schedule or a
 * dashboard schedule, minus whatever names its target. `attachPdf` is only
 * meaningful where the host passes `supportsPdf`.
 */
export interface DeliverySchedule extends Omit<ReportNotification, "costReportId"> {
  attachPdf?: boolean | undefined;
}

/** Create/update payload; a full replace, like both concrete inputs. */
export interface DeliveryScheduleInput extends ReportNotificationInput {
  attachPdf?: boolean | undefined;
}

/** The per-transport outcome of "Send now"; the PDF fields are dashboard-only. */
export interface DeliverySendResult extends ReportNotificationSendResult {
  pdfAttached?: boolean | undefined;
  slackFilesUploaded?: number | undefined;
}

/**
 * Data access for {@link DeliverySchedulesSection}, already bound to the one
 * report or dashboard the section belongs to.
 *
 * `list` is the read half. The rest is the manage half (`org:settings:write`
 * server-side); the section renders read-only unless the host supplies all of
 * `targets`, `create`, `update` and `remove`.
 */
export interface DeliverySchedulesClient {
  list(): Promise<DeliverySchedule[]>;
  targets?(): Promise<ReportDeliveryTargets>;
  create?(input: DeliveryScheduleInput): Promise<DeliverySchedule>;
  update?(scheduleId: string, input: DeliveryScheduleInput): Promise<DeliverySchedule>;
  remove?(scheduleId: string): Promise<void>;
  sendNow?(scheduleId: string): Promise<DeliverySendResult>;
}

/**
 * Host-injected access for a dashboard's PDF export and scheduled delivery.
 * Web wraps `apiFetch`, desktop wraps its cloud IPC.
 *
 * Every method is optional so a host can offer only what it supports: omit
 * `downloadPdf` to hide the download, omit `listNotifications` to hide the
 * schedule action, and omit the mutating methods (a viewer without
 * `org:settings:write`) to render the schedule list read-only.
 */
export interface DashboardExportClient {
  /** Render the dashboard server-side and save the PDF. */
  downloadPdf?(dashboardId: string, dashboardName: string): Promise<void>;
  listNotifications?(dashboardId: string): Promise<DashboardNotification[]>;
  listDeliveryTargets?(dashboardId: string): Promise<ReportDeliveryTargets>;
  createNotification?(
    dashboardId: string,
    input: DashboardNotificationInput,
  ): Promise<DashboardNotification>;
  updateNotification?(
    dashboardId: string,
    notificationId: string,
    input: DashboardNotificationInput,
  ): Promise<DashboardNotification>;
  deleteNotification?(dashboardId: string, notificationId: string): Promise<void>;
  sendNotificationNow?(
    dashboardId: string,
    notificationId: string,
  ): Promise<DashboardNotificationSendResult>;
}

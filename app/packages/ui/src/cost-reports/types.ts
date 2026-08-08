import type { CostReport, CostReportInput } from "@infrawrench/client-core";
import type { CostApi, CostsPanelDashboard } from "../cost/types.js";

/**
 * Host-injected data access for the cost-report components — the same shape
 * rule the cost components follow: web wraps `apiFetch`, desktop wraps its
 * cloud-api helpers, and nothing in here imports a platform primitive.
 *
 * The mutating half is optional. A viewer without `costs:write` gets a host
 * that omits it, and the views render read-only rather than showing controls
 * that fail on click — the same stance {@link CostsClient} takes on budgets.
 */
export interface CostReportsClient extends CostApi {
  listReports(): Promise<CostReport[]>;
  getReport(reportId: string): Promise<CostReport>;
  createReport?(input: CostReportInput): Promise<CostReport>;
  updateReport?(reportId: string, input: CostReportInput): Promise<CostReport>;
  deleteReport?(reportId: string): Promise<void>;
  /** Dashboards a report card can be added to, for the placement picker. */
  listDashboards?(): Promise<CostsPanelDashboard[]>;
  /** Add a `cost_report` card for `reportId` to `dashboardId`. */
  addReportToDashboard?(dashboardId: string, reportId: string, title: string): Promise<void>;
  /** Remove one card, identified by the widget id from `placements`. */
  removeReportPlacement?(widgetId: string): Promise<void>;
}

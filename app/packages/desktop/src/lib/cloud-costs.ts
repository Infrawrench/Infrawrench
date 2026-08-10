/**
 * Cloud cost graphs, budgets, and dashboard widgets. Cloud-mode only — cost
 * data has no local-SQLite equivalent (it lives in the cloud ClickHouse
 * store), so these are never called when activeCloudOrgId is unset.
 */
import type {
  BudgetInput,
  BudgetWithStatus,
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostAlertInput,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostDimensionOption,
  CostQueryRequest,
  CostQueryResponse,
  CostReport,
  CostReportInput,
  DashboardWidget,
  ShowbackReport,
  TagComplianceReport,
  TagPolicy,
  UntaggedSpendReport,
  CreditBurndown,
} from "@infrawrench/ui/cost";
import { invoke } from "./invoke";

export async function queryCloudCosts(
  orgId: string,
  request: CostQueryRequest,
): Promise<CostQueryResponse> {
  return invoke("cloud_costs_query", { orgId, request });
}

export async function loadCloudCostDimensionValues(
  orgId: string,
  dimension: string,
  tagKey?: string,
): Promise<CostDimensionOption[]> {
  const res = await invoke<{ values: Array<string | CostDimensionOption> }>(
    "cloud_costs_dimensions",
    { orgId, dimension, ...(tagKey ? { tagKey } : {}) },
  );
  return (res?.values ?? []).map((v) => (typeof v === "string" ? { value: v, label: v } : v));
}

export async function loadCloudCostStatus(orgId: string): Promise<CostAccountStatus[]> {
  const res = await invoke<{ accounts: CostAccountStatus[] }>("cloud_costs_status", { orgId });
  return res?.accounts ?? [];
}

export async function listCloudCostAnomalies(orgId: string, days = 30): Promise<CostAnomaly[]> {
  const res = await invoke<{ anomalies: CostAnomaly[] }>("cloud_costs_anomalies", { orgId, days });
  return res?.anomalies ?? [];
}

export async function loadCloudAnomalySettings(orgId: string): Promise<CostAnomalySettingsView> {
  return invoke("cloud_costs_anomaly_settings", { orgId });
}

export async function saveCloudAnomalySettings(
  orgId: string,
  settings: CostAnomalySettings,
): Promise<CostAnomalySettingsView> {
  return invoke("cloud_costs_update_anomaly_settings", { orgId, settings });
}

export async function loadCloudTagPolicy(orgId: string): Promise<TagPolicy> {
  return invoke("cloud_tag_policy", { orgId });
}

export async function loadCloudTagCompliance(orgId: string): Promise<TagComplianceReport> {
  return invoke("cloud_tag_compliance", { orgId });
}

export async function loadCloudUntaggedSpend(
  orgId: string,
  from?: string,
  to?: string,
): Promise<UntaggedSpendReport> {
  return invoke("cloud_costs_untagged", {
    orgId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
}

export async function loadCloudShowback(
  orgId: string,
  from?: string,
  to?: string,
): Promise<ShowbackReport> {
  return invoke("cloud_costs_showback", {
    orgId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
}

export async function loadCloudCreditBurndown(orgId: string): Promise<CreditBurndown> {
  return invoke("cloud_credit_burndown", { orgId });
}

export async function listCloudBudgets(orgId: string): Promise<BudgetWithStatus[]> {
  return invoke("cloud_list_budgets", { orgId });
}

export async function createCloudBudget(
  orgId: string,
  input: BudgetInput,
): Promise<{ id: string }> {
  return invoke("cloud_create_budget", { orgId, input });
}

export async function updateCloudBudget(
  orgId: string,
  budgetId: string,
  input: BudgetInput,
): Promise<void> {
  await invoke("cloud_update_budget", { orgId, budgetId, input });
}

export async function deleteCloudBudget(orgId: string, budgetId: string): Promise<void> {
  await invoke("cloud_delete_budget", { orgId, budgetId });
}

/* ------------------------------------------------------------------ *
 * Change-based cost alerts — configured relative change on a scope.
 * ------------------------------------------------------------------ */

export async function listCloudCostAlerts(orgId: string): Promise<CostAlert[]> {
  const res = await invoke<{ alerts: CostAlert[] }>("cloud_list_cost_alerts", { orgId });
  return res?.alerts ?? [];
}

export async function listCloudCostAlertEvents(
  orgId: string,
  options: { alertId?: string; limit?: number } = {},
): Promise<CostAlertEvent[]> {
  const res = await invoke<{ events: CostAlertEvent[] }>("cloud_list_cost_alert_events", {
    orgId,
    ...(options.alertId ? { alertId: options.alertId } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  return res?.events ?? [];
}

export async function createCloudCostAlert(
  orgId: string,
  input: CostAlertInput,
): Promise<CostAlert> {
  return invoke("cloud_create_cost_alert", { orgId, input });
}

export async function updateCloudCostAlert(
  orgId: string,
  alertId: string,
  input: CostAlertInput,
): Promise<CostAlert> {
  return invoke("cloud_update_cost_alert", { orgId, alertId, input });
}

export async function deleteCloudCostAlert(orgId: string, alertId: string): Promise<void> {
  await invoke("cloud_delete_cost_alert", { orgId, alertId });
}

export async function createCloudWidget(
  orgId: string,
  request: { dashboardId: string; kind: string; title?: string; config: unknown },
): Promise<DashboardWidget> {
  return invoke("cloud_create_widget", { orgId, request });
}

export async function updateCloudWidget(
  orgId: string,
  widgetId: string,
  request: { title?: string; config?: unknown },
): Promise<DashboardWidget> {
  return invoke("cloud_update_widget", { orgId, widgetId, request });
}

export async function deleteCloudWidget(orgId: string, widgetId: string): Promise<void> {
  await invoke("cloud_delete_widget", { orgId, widgetId });
}

/* ------------------------------------------------------------------ *
 * Cost reports — the named, saved form of a cost graph.
 * ------------------------------------------------------------------ */

export async function listCloudCostReports(orgId: string): Promise<CostReport[]> {
  return (await invoke<CostReport[]>("cloud_list_cost_reports", { orgId })) ?? [];
}

export async function getCloudCostReport(orgId: string, reportId: string): Promise<CostReport> {
  return invoke("cloud_get_cost_report", { orgId, reportId });
}

export async function createCloudCostReport(
  orgId: string,
  input: CostReportInput,
): Promise<CostReport> {
  return invoke("cloud_create_cost_report", { orgId, input });
}

export async function updateCloudCostReport(
  orgId: string,
  reportId: string,
  input: CostReportInput,
): Promise<CostReport> {
  return invoke("cloud_update_cost_report", { orgId, reportId, input });
}

export async function deleteCloudCostReport(orgId: string, reportId: string): Promise<void> {
  await invoke("cloud_delete_cost_report", { orgId, reportId });
}

/* ------------------------------------------------------------------ *
 * Cost-report folders — the tree the Reports list groups by.
 * ------------------------------------------------------------------ */

export async function listCloudCostReportFolders(orgId: string): Promise<CostReportFolder[]> {
  return (await invoke<CostReportFolder[]>("cloud_list_cost_report_folders", { orgId })) ?? [];
}

export async function createCloudCostReportFolder(
  orgId: string,
  input: CostReportFolderInput,
): Promise<CostReportFolder> {
  return invoke("cloud_create_cost_report_folder", { orgId, input });
}

export async function updateCloudCostReportFolder(
  orgId: string,
  folderId: string,
  input: CostReportFolderInput,
): Promise<CostReportFolder> {
  return invoke("cloud_update_cost_report_folder", { orgId, folderId, input });
}

export async function deleteCloudCostReportFolder(orgId: string, folderId: string): Promise<void> {
  await invoke("cloud_delete_cost_report_folder", { orgId, folderId });
}

/* ------------------------------------------------------------------ *
 * Report delivery schedules — scheduled sends of a saved report to
 * Slack/Teams/email. Cloud-only like everything else here.
 * ------------------------------------------------------------------ */

export async function listCloudReportNotifications(
  orgId: string,
  reportId: string,
): Promise<ReportNotification[]> {
  return (
    (await invoke<ReportNotification[]>("cloud_list_report_notifications", { orgId, reportId })) ??
    []
  );
}

export async function loadCloudReportDeliveryTargets(
  orgId: string,
  reportId: string,
): Promise<ReportDeliveryTargets> {
  return invoke("cloud_report_delivery_targets", { orgId, reportId });
}

export async function createCloudReportNotification(
  orgId: string,
  reportId: string,
  input: ReportNotificationInput,
): Promise<ReportNotification> {
  return invoke("cloud_create_report_notification", { orgId, reportId, input });
}

export async function updateCloudReportNotification(
  orgId: string,
  reportId: string,
  notificationId: string,
  input: ReportNotificationInput,
): Promise<ReportNotification> {
  return invoke("cloud_update_report_notification", { orgId, reportId, notificationId, input });
}

export async function deleteCloudReportNotification(
  orgId: string,
  reportId: string,
  notificationId: string,
): Promise<void> {
  await invoke("cloud_delete_report_notification", { orgId, reportId, notificationId });
}

export async function sendCloudReportNotificationNow(
  orgId: string,
  reportId: string,
  notificationId: string,
): Promise<ReportNotificationSendResult> {
  return invoke("cloud_send_report_notification", { orgId, reportId, notificationId });
}

/* ------------------------------------------------------------------ *
 * Saved cost filters — named filter sets applied by reference. Cloud-mode
 * only, and resolved server-side at query time like every other surface.
 * ------------------------------------------------------------------ */

export async function listCloudSavedCostFilters(orgId: string): Promise<SavedCostFilter[]> {
  return (await invoke<SavedCostFilter[]>("cloud_list_saved_cost_filters", { orgId })) ?? [];
}

export async function createCloudSavedCostFilter(
  orgId: string,
  input: SavedCostFilterInput,
): Promise<SavedCostFilter> {
  return invoke("cloud_create_saved_cost_filter", { orgId, input });
}

export async function updateCloudSavedCostFilter(
  orgId: string,
  savedFilterId: string,
  input: SavedCostFilterInput,
): Promise<SavedCostFilter> {
  return invoke("cloud_update_saved_cost_filter", { orgId, savedFilterId, input });
}

/** Rejects with the server's 409 message (naming referents) while referenced. */
export async function deleteCloudSavedCostFilter(
  orgId: string,
  savedFilterId: string,
): Promise<void> {
  await invoke("cloud_delete_saved_cost_filter", { orgId, savedFilterId });
}

export async function listCloudSavedCostFilterReferents(
  orgId: string,
  savedFilterId: string,
): Promise<SavedCostFilterReferent[]> {
  const res = await invoke<{ referents: SavedCostFilterReferent[] }>(
    "cloud_saved_cost_filter_referents",
    { orgId, savedFilterId },
  );
  return res?.referents ?? [];
}

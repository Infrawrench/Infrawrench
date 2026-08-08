/**
 * Cloud cost graphs, budgets, and dashboard widgets. Cloud-mode only — cost
 * data has no local-SQLite equivalent (it lives in the cloud ClickHouse
 * store), so these are never called when activeCloudOrgId is unset.
 */
import type {
  BudgetInput,
  BudgetWithStatus,
  CostAccountStatus,
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

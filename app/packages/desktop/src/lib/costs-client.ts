import type {
  BudgetInput,
  BusinessMetricInput,
  BusinessMetricValueInput,
  CostAlertInput,
  CostAnomalySettings,
  CostsClient,
  CostsPanelDashboard,
  SavedCostFilterInput,
  CostScenarioModelInput,
} from "@infrawrench/ui/cost";
import {
  acknowledgeCloudCostAnomaly,
  createCloudBudget,
  createCloudCostAlert,
  createCloudWidget,
  deleteCloudBudget,
  deleteCloudCostAlert,
  deleteCloudWidget,
  listCloudBudgets,
  listCloudCostAlertEvents,
  listCloudCostAlerts,
  listCloudCostAnomalies,
  loadCloudAnomalySettings,
  loadCloudBillingRules,
  loadCloudShowback,
  loadCloudCommitments,
  loadCloudEfficiencyAlerts,
  loadCloudEfficiencySettings,
  saveCloudEfficiencySettings,
  loadCloudCreditBurndown,
  loadCloudTagCompliance,
  loadCloudUntaggedSpend,
  saveCloudAnomalySettings,
  updateCloudBudget,
  updateCloudCostAlert,
  deleteCloudSavedCostFilter,
  listCloudSavedCostFilterReferents,
  createCloudCostScenarioModel,
  updateCloudCostScenarioModel,
  deleteCloudCostScenarioModel,
  listCloudCostScenarioReferents,
  updateCloudSavedCostFilter,
  createCloudBusinessMetric,
  deleteCloudBusinessMetric,
  listCloudBusinessMetricValues,
  updateCloudBusinessMetric,
  writeCloudBusinessMetricValues,
} from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";
import { createDesktopCostApi, requireCloudOrgId as requireOrgId } from "./cost-api";

/**
 * The full Costs panel client: the shared read calls plus budget CRUD, the
 * anomaly and alert surfaces, and the management half of saved filters,
 * scenario models and business metrics.
 *
 * The reads come from {@link createDesktopCostApi} rather than being restated
 * here, so the Costs panel, the Cost reports page and the dashboard's cost
 * cards cannot drift apart — the mirror of web's `createWebCostsClient`.
 */
export function createDesktopCostsClient(): CostsClient {
  return {
    ...createDesktopCostApi(),
    // Saved filters get the full editor on desktop for the same reason the
    // anomaly tuning does: the Costs panel is the same shared component, and
    // the filters are org-level cloud state either way.
    updateSavedFilter: (savedFilterId: string, input: SavedCostFilterInput) =>
      updateCloudSavedCostFilter(requireOrgId(), savedFilterId, input),
    deleteSavedFilter: (savedFilterId: string) =>
      deleteCloudSavedCostFilter(requireOrgId(), savedFilterId),
    getSavedFilterReferents: (savedFilterId: string) =>
      listCloudSavedCostFilterReferents(requireOrgId(), savedFilterId),
    // Scenario models get the full editor on desktop, like saved filters: the
    // Costs panel is the same shared component in both hosts, and a model is
    // org-level cloud state either way.
    createScenarioModel: (input: CostScenarioModelInput) =>
      createCloudCostScenarioModel(requireOrgId(), input),
    updateScenarioModel: (modelId: string, input: CostScenarioModelInput) =>
      updateCloudCostScenarioModel(requireOrgId(), modelId, input),
    deleteScenarioModel: (modelId: string) => deleteCloudCostScenarioModel(requireOrgId(), modelId),
    getScenarioModelReferents: (modelId: string) =>
      listCloudCostScenarioReferents(requireOrgId(), modelId),
    // Business metrics get the full editor on desktop, like saved filters and
    // anomaly tuning: the Costs panel is the same shared component in both
    // hosts, and a metric is org-level cloud state either way.
    createBusinessMetric: (input: BusinessMetricInput) =>
      createCloudBusinessMetric(requireOrgId(), input),
    updateBusinessMetric: (metricId: string, input: BusinessMetricInput) =>
      updateCloudBusinessMetric(requireOrgId(), metricId, input),
    deleteBusinessMetric: (metricId: string) => deleteCloudBusinessMetric(requireOrgId(), metricId),
    listBusinessMetricValues: (metricId: string, limit?: number) =>
      listCloudBusinessMetricValues(requireOrgId(), metricId, limit),
    writeBusinessMetricValues: (metricId: string, values: BusinessMetricValueInput[]) =>
      writeCloudBusinessMetricValues(requireOrgId(), metricId, values),
    listBudgets: () => listCloudBudgets(requireOrgId()),
    listAnomalies: (days?: number) => listCloudCostAnomalies(requireOrgId(), days),
    // Explaining a finding is org-level cloud state like the tuning below it,
    // so desktop gets the composer too rather than a list it can only read.
    acknowledgeAnomaly: (anomalyId: string, explanation: string) =>
      acknowledgeCloudCostAnomaly(requireOrgId(), anomalyId, explanation),
    // Desktop gets the tuning editor too: the Costs panel is the same
    // component in both hosts, and the settings are org-level cloud state
    // either way — leaving it out would make the desktop panel quietly less
    // capable than the web one for no reason a user could work out.
    getAnomalySettings: () => loadCloudAnomalySettings(requireOrgId()),
    updateAnomalySettings: (settings: CostAnomalySettings) =>
      saveCloudAnomalySettings(requireOrgId(), settings),
    // Change-based cost alerts are org-level cloud state like anomaly
    // settings, so desktop wires the full editing surface too.
    listCostAlerts: () => listCloudCostAlerts(requireOrgId()),
    listCostAlertEvents: (options?: { alertId?: string; limit?: number }) =>
      listCloudCostAlertEvents(requireOrgId(), options),
    createCostAlert: (input: CostAlertInput) => createCloudCostAlert(requireOrgId(), input),
    updateCostAlert: (alertId: string, input: CostAlertInput) =>
      updateCloudCostAlert(requireOrgId(), alertId, input),
    deleteCostAlert: (alertId: string) => deleteCloudCostAlert(requireOrgId(), alertId),
    listDashboards: async (): Promise<CostsPanelDashboard[]> => {
      const rows = await listCloudDashboards(requireOrgId());
      return rows.map((d) => ({ id: d.id, name: d.name }));
    },
    createBudget: (input: BudgetInput) => createCloudBudget(requireOrgId(), input),
    updateBudget: (budgetId: string, input: BudgetInput) =>
      updateCloudBudget(requireOrgId(), budgetId, input),
    deleteBudget: (budgetId: string) => deleteCloudBudget(requireOrgId(), budgetId),
    addBudgetToDashboard: async (dashboardId: string, budgetId: string, title: string) => {
      await createCloudWidget(requireOrgId(), {
        dashboardId,
        kind: "budget",
        title,
        config: { version: 1, budgetId },
      });
    },
    removeBudgetPlacement: (widgetId: string) => deleteCloudWidget(requireOrgId(), widgetId),
    // The tag governance section is read-only in the shared panel, so desktop
    // wires all three reads; policy and rule editing stays in web org settings.
    getTagCompliance: () => loadCloudTagCompliance(requireOrgId()),
    getUntaggedSpend: (from?: string, to?: string) =>
      loadCloudUntaggedSpend(requireOrgId(), from, to),
    getShowback: (from?: string, to?: string) => loadCloudShowback(requireOrgId(), from, to),
    // Read-only here for the same reason the tag rules are: the panel only
    // needs to know whether any rule is in force. Editing stays in Settings →
    // Billing Rules, behind `org:settings:write`.
    listBillingRules: () => loadCloudBillingRules(requireOrgId()),
    getCreditBurndown: () => loadCloudCreditBurndown(requireOrgId()),
    getCommitments: () => loadCloudCommitments(requireOrgId()),
    listEfficiencyAlerts: (options) => loadCloudEfficiencyAlerts(requireOrgId(), options ?? {}),
    getEfficiencyAlertSettings: () => loadCloudEfficiencySettings(requireOrgId()),
    updateEfficiencyAlertSettings: (settings) =>
      saveCloudEfficiencySettings(requireOrgId(), settings),
  };
}

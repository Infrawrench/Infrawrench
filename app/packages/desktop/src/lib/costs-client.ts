import { useUIStore } from "@infrawrench/ui";
import type {
  BudgetInput,
  CostAlertInput,
  CostAnomalySettings,
  CostsClient,
  CostsPanelDashboard,
  SavedCostFilterInput,
} from "@infrawrench/ui/cost";
import {
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
  loadCloudCostDimensionValues,
  loadCloudCostStatus,
  loadCloudShowback,
  loadCloudCommitments,
  loadCloudCreditBurndown,
  loadCloudTagCompliance,
  loadCloudUntaggedSpend,
  queryCloudCosts,
  saveCloudAnomalySettings,
  updateCloudBudget,
  updateCloudCostAlert,
  createCloudSavedCostFilter,
  deleteCloudSavedCostFilter,
  listCloudSavedCostFilterReferents,
  listCloudSavedCostFilters,
  updateCloudSavedCostFilter,
} from "./cloud-costs";
import { listCloudDashboards } from "./cloud-dashboards";

/**
 * Costs are cloud-only: spend is collected server-side, so a desktop app in
 * local mode has nothing to show. Every call resolves the active org at call
 * time rather than closing over it, matching the dashboard's cost API — the
 * org can change under a mounted panel when the user switches org.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Costs and budgets require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopCostsClient(): CostsClient {
  return {
    queryCosts: (req) => queryCloudCosts(requireOrgId(), req),
    loadDimensionValues: (dimension, tagKey) => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return loadCloudCostDimensionValues(orgId, dimension, tagKey);
    },
    loadCostStatus: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return Promise.resolve([]);
      return loadCloudCostStatus(orgId);
    },
    // Saved filters get the full editor on desktop for the same reason the
    // anomaly tuning does: the Costs panel is the same shared component, and
    // the filters are org-level cloud state either way.
    listSavedFilters: () => listCloudSavedCostFilters(requireOrgId()),
    createSavedFilter: (input: SavedCostFilterInput) =>
      createCloudSavedCostFilter(requireOrgId(), input),
    updateSavedFilter: (savedFilterId: string, input: SavedCostFilterInput) =>
      updateCloudSavedCostFilter(requireOrgId(), savedFilterId, input),
    deleteSavedFilter: (savedFilterId: string) =>
      deleteCloudSavedCostFilter(requireOrgId(), savedFilterId),
    getSavedFilterReferents: (savedFilterId: string) =>
      listCloudSavedCostFilterReferents(requireOrgId(), savedFilterId),
    listBudgets: () => listCloudBudgets(requireOrgId()),
    listAnomalies: (days?: number) => listCloudCostAnomalies(requireOrgId(), days),
    // Desktop gets the tuning editor too: the Costs panel is the same
    // component in both hosts, and the settings are org-level cloud state
    // either way — leaving it out would make the desktop panel quietly less
    // capable than the web one for no reason a user could work out.
    getAnomalySettings: () => loadCloudAnomalySettings(requireOrgId()),
    updateAnomalySettings: (settings: CostAnomalySettings) =>
      saveCloudAnomalySettings(requireOrgId(), settings),
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
    getCreditBurndown: () => loadCloudCreditBurndown(requireOrgId()),
  };
}

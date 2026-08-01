import type {
  BudgetInput,
  BudgetWithStatus,
  CostAccountStatus,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostApi,
  CostDimensionOption,
  CostQueryRequest,
  CostQueryResponse,
  CostsClient,
  CostsPanelDashboard,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/ui/cost";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * The read-only cost calls, shared by the dashboard's cost cards and the Costs
 * panel. Both render the same components, so both need the same `CostApi`;
 * keeping one definition means a change to the query endpoint cannot reach one
 * surface and miss the other.
 */
export function createWebCostApi(orgId: string): CostApi {
  return {
    queryCosts: (req: CostQueryRequest) =>
      apiPost<CostQueryResponse>(`/api/org/${orgId}/costs/query`, req),
    loadDimensionValues: async (dimension: string, tagKey?: string) => {
      const params = new URLSearchParams({ dimension });
      if (tagKey) params.set("tagKey", tagKey);
      const res = await apiGet<{ values: Array<string | CostDimensionOption> }>(
        `/api/org/${orgId}/costs/dimensions?${params}`,
      );
      return res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v));
    },
    loadCostStatus: async () => {
      const res = await apiGet<{ accounts: CostAccountStatus[] }>(`/api/org/${orgId}/costs/status`);
      return res.accounts;
    },
  };
}

/**
 * The full Costs panel client: the read calls above plus budget CRUD and the
 * dashboard-placement calls.
 *
 * Adding a placement is a plain widget POST — the same call the dashboard "+"
 * menu makes — because "add an existing budget to a dashboard" and "create a
 * budget and show it here" only differ in whether a budget row is created
 * first.
 */
export function createWebCostsClient(orgId: string): CostsClient {
  return {
    ...createWebCostApi(orgId),
    listBudgets: () => apiGet<BudgetWithStatus[]>(`/api/org/${orgId}/budgets`),
    listAnomalies: async (days = 30) => {
      const res = await apiGet<{ anomalies: CostAnomaly[] }>(
        `/api/org/${orgId}/costs/anomalies?days=${days}`,
      );
      return res.anomalies;
    },
    getAnomalySettings: () =>
      apiGet<CostAnomalySettingsView>(`/api/org/${orgId}/costs/anomaly-settings`),
    updateAnomalySettings: (settings: CostAnomalySettings) =>
      apiPut<CostAnomalySettingsView>(`/api/org/${orgId}/costs/anomaly-settings`, settings),
    listDashboards: () => apiGet<CostsPanelDashboard[]>(`/api/org/${orgId}/dashboards`),
    createBudget: (input: BudgetInput) =>
      apiPost<{ id: string }>(`/api/org/${orgId}/budgets`, input),
    updateBudget: async (budgetId: string, input: BudgetInput) => {
      await apiPut(`/api/org/${orgId}/budgets/${budgetId}`, input);
    },
    deleteBudget: async (budgetId: string) => {
      await apiDelete(`/api/org/${orgId}/budgets/${budgetId}`);
    },
    addBudgetToDashboard: async (dashboardId: string, budgetId: string, title: string) => {
      await apiPost(`/api/org/${orgId}/dashboards/widgets`, {
        dashboardId,
        kind: "budget",
        title,
        config: { version: 1, budgetId },
      });
    },
    removeBudgetPlacement: async (widgetId: string) => {
      await apiDelete(`/api/org/${orgId}/dashboards/widgets/${widgetId}`);
    },
    getTagCompliance: () => apiGet<TagComplianceReport>(`/api/org/${orgId}/tag-policy/compliance`),
    getUntaggedSpend: (from?: string, to?: string) =>
      apiGet<UntaggedSpendReport>(`/api/org/${orgId}/costs/untagged${rangeQuery(from, to)}`),
    getShowback: (from?: string, to?: string) =>
      apiGet<ShowbackReport>(`/api/org/${orgId}/costs/showback${rangeQuery(from, to)}`),
  };
}

function rangeQuery(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

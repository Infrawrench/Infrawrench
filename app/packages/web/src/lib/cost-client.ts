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
  CostApi,
  CostDimensionOption,
  CostQueryRequest,
  CostQueryResponse,
  CostsClient,
  CostsPanelDashboard,
  CreditBurndown,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/ui/cost";
import type { CostReportsClient } from "@infrawrench/ui/cost-reports";
import type { CostReport, CostReportInput } from "@infrawrench/client-core";
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
    // Saved filters ride on the base CostApi because every surface that can
    // author a filter (graph modal, budget modal, report editor) offers the
    // picker and "Save these rows as a filter…".
    listSavedFilters: () => apiGet<SavedCostFilter[]>(`/api/org/${orgId}/saved-cost-filters`),
    createSavedFilter: (input: SavedCostFilterInput) =>
      apiPost<SavedCostFilter>(`/api/org/${orgId}/saved-cost-filters`, input),
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
    listCostAlerts: async () => {
      const res = await apiGet<{ alerts: CostAlert[] }>(`/api/org/${orgId}/cost-alerts`);
      return res.alerts;
    },
    listCostAlertEvents: async (options?: { alertId?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (options?.alertId) params.set("alertId", options.alertId);
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      const res = await apiGet<{ events: CostAlertEvent[] }>(
        `/api/org/${orgId}/cost-alerts/events${qs ? `?${qs}` : ""}`,
      );
      return res.events;
    },
    createCostAlert: (input: CostAlertInput) =>
      apiPost<CostAlert>(`/api/org/${orgId}/cost-alerts`, input),
    updateCostAlert: (alertId: string, input: CostAlertInput) =>
      apiPut<CostAlert>(`/api/org/${orgId}/cost-alerts/${alertId}`, input),
    deleteCostAlert: async (alertId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-alerts/${alertId}`);
    },
    updateSavedFilter: (savedFilterId: string, input: SavedCostFilterInput) =>
      apiPut<SavedCostFilter>(`/api/org/${orgId}/saved-cost-filters/${savedFilterId}`, input),
    // A 409 here is the deliberate refusal: the filter is still referenced,
    // and the error message names the referents (apiDelete surfaces the body).
    deleteSavedFilter: async (savedFilterId: string) => {
      await apiDelete(`/api/org/${orgId}/saved-cost-filters/${savedFilterId}`);
    },
    getSavedFilterReferents: async (savedFilterId: string) => {
      const res = await apiGet<{ referents: SavedCostFilterReferent[] }>(
        `/api/org/${orgId}/saved-cost-filters/${savedFilterId}/referents`,
      );
      return res.referents;
    },
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
    getCreditBurndown: () => apiGet<CreditBurndown>(`/api/org/${orgId}/credits`),
  };
}

/**
 * The Cost reports client — the same read calls again, plus report CRUD and the
 * dashboard-placement calls for `cost_report` cards.
 *
 * A separate client from {@link createWebCostsClient} because a report is its
 * own page with its own permissions story, but it shares `createWebCostApi` so
 * the chart on a report renders through exactly the query endpoint a dashboard
 * cost card does.
 */
export function createWebCostReportsClient(orgId: string): CostReportsClient {
  return {
    ...createWebCostApi(orgId),
    listReports: () => apiGet<CostReport[]>(`/api/org/${orgId}/cost-reports`),
    getReport: (reportId: string) =>
      apiGet<CostReport>(`/api/org/${orgId}/cost-reports/${reportId}`),
    createReport: (input: CostReportInput) =>
      apiPost<CostReport>(`/api/org/${orgId}/cost-reports`, input),
    updateReport: (reportId: string, input: CostReportInput) =>
      apiPut<CostReport>(`/api/org/${orgId}/cost-reports/${reportId}`, input),
    deleteReport: async (reportId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-reports/${reportId}`);
    },
    listFolders: () => apiGet<CostReportFolder[]>(`/api/org/${orgId}/cost-report-folders`),
    createFolder: (input: CostReportFolderInput) =>
      apiPost<CostReportFolder>(`/api/org/${orgId}/cost-report-folders`, input),
    updateFolder: (folderId: string, input: CostReportFolderInput) =>
      apiPut<CostReportFolder>(`/api/org/${orgId}/cost-report-folders/${folderId}`, input),
    deleteFolder: async (folderId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-report-folders/${folderId}`);
    },
    listDashboards: () => apiGet<CostsPanelDashboard[]>(`/api/org/${orgId}/dashboards`),
    addReportToDashboard: async (dashboardId: string, reportId: string, title: string) => {
      await apiPost(`/api/org/${orgId}/dashboards/widgets`, {
        dashboardId,
        kind: "cost_report",
        title,
        config: { version: 1, reportId },
      });
    },
    removeReportPlacement: async (widgetId: string) => {
      await apiDelete(`/api/org/${orgId}/dashboards/widgets/${widgetId}`);
    },
  };
}

function rangeQuery(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

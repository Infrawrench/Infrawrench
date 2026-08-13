import type {
  BillingRule,
  BudgetInput,
  BudgetWithStatus,
  BusinessMetric,
  BusinessMetricInput,
  BusinessMetricValue,
  BusinessMetricValueInput,
  BusinessMetricWriteResult,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
  CostAccountStatus,
  CostAnnotation,
  CostAnnotationInput,
  CostAlert,
  CostAlertEvent,
  CostAlertInput,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostEfficiencySettings,
  EfficiencyAlertEvent,
  EfficiencyAlertKind,
  CostApi,
  CostDimensionOption,
  CostQueryRequest,
  CostQueryResponse,
  CostsClient,
  CostsPanelDashboard,
  SavedCostFilter,
  SavedCostFilterInput,
  SavedCostFilterReferent,
  CostScenarioModel,
  CostScenarioModelInput,
  CostScenarioReferent,
  CommitmentsFeed,
  NetworkFlowFeed,
  CreditBurndown,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/ui/cost";
import type { CostReportsClient } from "@infrawrench/ui/cost-reports";
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
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * The read-only cost calls, shared by the dashboard's cost cards and the Costs
 * panel. Both render the same components, so both need the same `CostApi`;
 * keeping one definition means a change to the query endpoint cannot reach one
 * surface and miss the other.
 */
function createWebCostApi(orgId: string): CostApi {
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
    // Scenario models ride the base CostApi for the same reason saved filters
    // do: every surface that can author or draw a cost graph needs the list —
    // the picker in the editor, and the card that labels an applied scenario.
    listScenarioModels: async () => {
      const res = await apiGet<{ models: CostScenarioModel[] }>(`/api/org/${orgId}/cost-scenarios`);
      return res.models;
    },
    // Annotations ride the base CostApi so an org-wide note is drawn on every
    // cost chart — the dashboard card as much as the saved report. The writes
    // are included unconditionally (server-side `costs:write`), so a viewer's
    // 403 surfaces as the action's error rather than as a missing button.
    listCostAnnotations: async (reportId?: string) => {
      const qs = reportId ? `?reportId=${encodeURIComponent(reportId)}` : "";
      const res = await apiGet<{ annotations: CostAnnotation[] }>(
        `/api/org/${orgId}/cost-annotations${qs}`,
      );
      return res.annotations;
    },
    createCostAnnotation: (input: CostAnnotationInput) =>
      apiPost<CostAnnotation>(`/api/org/${orgId}/cost-annotations`, input),
    updateCostAnnotation: (annotationId: string, input: CostAnnotationInput) =>
      apiPut<CostAnnotation>(`/api/org/${orgId}/cost-annotations/${annotationId}`, input),
    deleteCostAnnotation: async (annotationId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-annotations/${annotationId}`);
    },
    // Business metrics ride the base CostApi for the same reason saved filters
    // do: every surface that can author or draw a cost graph needs them — the
    // picker in the editor, and the card that divides spend by one.
    listBusinessMetrics: async () => {
      const res = await apiGet<{ metrics: BusinessMetric[] }>(`/api/org/${orgId}/business-metrics`);
      return res.metrics;
    },
    queryUnitCosts: (metricId: string, request: UnitCostQueryRequest) =>
      apiPost<UnitCostQueryResponse>(
        `/api/org/${orgId}/business-metrics/${encodeURIComponent(metricId)}/unit-costs`,
        request,
      ),
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
    // Offered unconditionally, like the annotation writes: the server enforces
    // `costs:write`, so a viewer's 403 surfaces as the action's error rather
    // than as an action that quietly isn't there.
    acknowledgeAnomaly: (anomalyId: string, explanation: string) =>
      apiPost<CostAnomaly>(
        `/api/org/${orgId}/costs/anomalies/${encodeURIComponent(anomalyId)}/acknowledge`,
        { explanation },
      ),
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
    createScenarioModel: (input: CostScenarioModelInput) =>
      apiPost<CostScenarioModel>(`/api/org/${orgId}/cost-scenarios`, input),
    updateScenarioModel: (modelId: string, input: CostScenarioModelInput) =>
      apiPut<CostScenarioModel>(`/api/org/${orgId}/cost-scenarios/${modelId}`, input),
    // A 409 here is the deliberate refusal: something still references the
    // model, and the error message names it (apiDelete surfaces the body).
    deleteScenarioModel: async (modelId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-scenarios/${modelId}`);
    },
    getScenarioModelReferents: async (modelId: string) => {
      const res = await apiGet<{ referents: CostScenarioReferent[] }>(
        `/api/org/${orgId}/cost-scenarios/${modelId}/referents`,
      );
      return res.referents;
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
    // Read-only: the panel only needs to know whether any rule is in force, so
    // it can decide whether an "Apply billing rules" toggle means anything.
    // Management is Settings → Billing Rules, behind `org:settings:write`.
    listBillingRules: () => apiGet<BillingRule[]>(`/api/org/${orgId}/billing-rules`),
    createBusinessMetric: (input: BusinessMetricInput) =>
      apiPost<BusinessMetric>(`/api/org/${orgId}/business-metrics`, input),
    updateBusinessMetric: (metricId: string, input: BusinessMetricInput) =>
      apiPut<BusinessMetric>(
        `/api/org/${orgId}/business-metrics/${encodeURIComponent(metricId)}`,
        input,
      ),
    deleteBusinessMetric: async (metricId: string) => {
      await apiDelete(`/api/org/${orgId}/business-metrics/${encodeURIComponent(metricId)}`);
    },
    listBusinessMetricValues: async (metricId: string, limit = 90) => {
      const res = await apiGet<{ values: BusinessMetricValue[] }>(
        `/api/org/${orgId}/business-metrics/${encodeURIComponent(metricId)}/values?limit=${limit}`,
      );
      return res.values;
    },
    writeBusinessMetricValues: (metricId: string, values: BusinessMetricValueInput[]) =>
      apiPost<BusinessMetricWriteResult>(
        `/api/org/${orgId}/business-metrics/${encodeURIComponent(metricId)}/values`,
        { values },
      ),
    getCreditBurndown: () => apiGet<CreditBurndown>(`/api/org/${orgId}/credits`),
    getCommitments: () => apiGet<CommitmentsFeed>(`/api/org/${orgId}/commitments`),
    getNetworkFlows: (options?: { from?: string; to?: string; scope?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (options?.from) params.set("from", options.from);
      if (options?.to) params.set("to", options.to);
      if (options?.scope) params.set("scope", options.scope);
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return apiGet<NetworkFlowFeed>(`/api/org/${orgId}/network-flows${qs ? `?${qs}` : ""}`);
    },
    // Included unconditionally, like the annotation writes above: the server
    // enforces `org:settings:write` (a stricter permission than the rest of
    // this client, because enabling collection spends the org's money in its
    // own cloud account daily), and a viewer's 403 surfaces as the switch's
    // error rather than as a control that silently isn't there.
    updateNetworkFlowSettings: (settings: { enabled: boolean; initialLookbackDays?: number }) =>
      apiPut<{ enabled: boolean; initialLookbackDays: number }>(
        `/api/org/${orgId}/network-flows/settings`,
        settings,
      ),
    listEfficiencyAlerts: async (options?: { kind?: EfficiencyAlertKind; limit?: number }) => {
      const params = new URLSearchParams();
      if (options?.kind) params.set("kind", options.kind);
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      const res = await apiGet<{ events: EfficiencyAlertEvent[] }>(
        `/api/org/${orgId}/costs/efficiency-alerts${qs ? `?${qs}` : ""}`,
      );
      return res.events;
    },
    getEfficiencyAlertSettings: () =>
      apiGet<CostEfficiencySettings>(`/api/org/${orgId}/costs/efficiency-alert-settings`),
    updateEfficiencyAlertSettings: (settings: CostEfficiencySettings) =>
      apiPut<CostEfficiencySettings>(`/api/org/${orgId}/costs/efficiency-alert-settings`, settings),
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
    // Delivery schedules. The mutating half is org:settings:write server-side;
    // included unconditionally so a 403 surfaces as the action's error rather
    // than the buttons silently missing.
    listReportNotifications: (reportId: string) =>
      apiGet<ReportNotification[]>(`/api/org/${orgId}/cost-reports/${reportId}/notifications`),
    listReportDeliveryTargets: (reportId: string) =>
      apiGet<ReportDeliveryTargets>(
        `/api/org/${orgId}/cost-reports/${reportId}/notifications/targets`,
      ),
    createReportNotification: (reportId: string, input: ReportNotificationInput) =>
      apiPost<ReportNotification>(
        `/api/org/${orgId}/cost-reports/${reportId}/notifications`,
        input,
      ),
    updateReportNotification: (
      reportId: string,
      notificationId: string,
      input: ReportNotificationInput,
    ) =>
      apiPut<ReportNotification>(
        `/api/org/${orgId}/cost-reports/${reportId}/notifications/${notificationId}`,
        input,
      ),
    deleteReportNotification: async (reportId: string, notificationId: string) => {
      await apiDelete(`/api/org/${orgId}/cost-reports/${reportId}/notifications/${notificationId}`);
    },
    sendReportNotificationNow: (reportId: string, notificationId: string) =>
      apiPost<ReportNotificationSendResult>(
        `/api/org/${orgId}/cost-reports/${reportId}/notifications/${notificationId}/send`,
        {},
      ),
  };
}

function rangeQuery(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Cloud cost graphs, budgets, and dashboard widgets. Cloud-mode only: cost
 * data has no local-SQLite equivalent (it lives in the cloud ClickHouse
 * store), so these are never called when activeCloudOrgId is unset.
 *
 * Typed calls to the contract's cost domains over the cloud transport
 * (`./cloud-client.ts`), as in `cloud-probes.ts`: each answer is the server's
 * JSON, handed on as the client-core or ui type the panels use, so a contract
 * change the desktop's types disagree with fails here at compile time. The
 * answers that are not JSON (the FOCUS CSV, the export job file and the two
 * PDFs) still ride their own IPC channels (`electron/cloud-data/costs.ts`).
 */
import type {
  CostCentre,
  CostExportJob,
  CostExportJobRequest,
  CostReportAnomalyAlert,
  CostReportAnomalyAlertInput,
} from "@infrawrench/client-core";
import type { DestinationCatalog } from "@infrawrench/ui/cost-reports";
import type {
  BusinessMetricForecastValue,
  BusinessMetricForecastValueInput,
  CostForecast,
  CostForecastInput,
  CostForecastResult,
  CostForecastRunRequest,
  CarbonEstimate,
  BillingRule,
  BudgetInput,
  BudgetWithStatus,
  BusinessMetric,
  BusinessMetricImporter,
  BusinessMetricImporterInput,
  BusinessMetricImportPreview,
  BusinessMetricImportPreviewRequest,
  BusinessMetricImportRun,
  BusinessMetricImportRunRequest,
  BusinessMetricSourceAccount,
  BusinessMetricSourceOption,
  BusinessMetricSourceOptionsRequest,
  BusinessMetricInput,
  BusinessMetricLabelSummary,
  BusinessMetricValue,
  BusinessMetricValueInput,
  BusinessMetricWriteResult,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostAlertInput,
  CostAnomaly,
  CostAnnotation,
  CostAnnotationInput,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostDimensionOption,
  CostQueryRequest,
  CostQueryResponse,
  CostReport,
  CostReportFolder,
  CostReportFolderInput,
  CostReportInput,
  DashboardWidget,
  SavedCostFilter,
  SavedCostFilterInput,
  SavedCostFilterReferent,
  CostScenarioModel,
  CostScenarioModelInput,
  CostScenarioReferent,
  ShowbackReport,
  TagComplianceReport,
  TagPolicy,
  UntaggedSpendReport,
  CommitmentsFeed,
  CreditBurndown,
  KubernetesNetworkReport,
  KubernetesNetworkSettings,
  NetworkFlowFeed,
} from "@infrawrench/ui/cost";
import type {
  BudgetAlertEvent,
  BudgetAlertNoteResult,
  CostReportBulkRequest,
  CostReportBulkResult,
  CostEfficiencySettings,
  EfficiencyAlertEvent,
  EfficiencyAlertKind,
  DashboardNotification,
  DashboardNotificationInput,
  DashboardNotificationSendResult,
  FocusExportRequest,
  ReportDeliveryTargets,
  ReportNotification,
  ReportNotificationInput,
  ReportNotificationSendResult,
  CostAnomalyFeedbackInput,
  CostAnomalyFeedbackResult,
  CostAnomalyPrecisionReport,
  CostAnomalySensitivity,
  CostAnomalySuppression,
  CostAnomalySuppressionInput,
  AlertEmailOptions,
  DashboardWidgetKind,
} from "@infrawrench/client-core";
import type {
  DashboardKpiResult,
  KpiWidgetConfig,
  RealizedSavingsReport,
  RealizedSavingsSettings,
  SavingsEvent,
  SavingsEventAnnotationInput,
  SavingsEventInput,
} from "@infrawrench/client-core";
import type { SavingsResourceOption } from "@infrawrench/ui/cost";
import { Effect, Predicate } from "effect";
import { cloudClient, CloudRequestEncodeError } from "./cloud-client";
import { definedFields, pdfTimezoneQuery } from "./cloud-payload";
import { runRpc } from "./rpc/client";

const costs = () => cloudClient("costs").costs;
const exportJobs = () => cloudClient("costExportJobs").costExportJobs;
const reportAnomalyAlerts = () => cloudClient("costReportAnomalyAlerts");
const anomalyFeedback = () => cloudClient("costAnomalyFeedback").costAnomalyFeedback;
const budgets = () => cloudClient("budgets").budgets;
const networkFlows = () => cloudClient("networkFlows").networkFlows;
const savings = () => cloudClient("savings").savings;
const costAlerts = () => cloudClient("costAlerts").costAlerts;
const widgets = () => cloudClient("dashboards").dashboardWidgets;
const costReports = () => cloudClient("costReports").costReports;
const costForecasts = () => cloudClient("costReports").costForecasts;
const annotations = () => cloudClient("costAnnotations").costAnnotations;
const folders = () => cloudClient("costReportFolders").costReportFolders;
const reportDelivery = () => cloudClient("costReportNotifications").costReportNotifications;
const dashboardDelivery = () => cloudClient("dashboardNotifications").dashboardDelivery;
const reportPdf = () => cloudClient("dashboardNotifications").costReportPdf;
const savedFilters = () => cloudClient("savedCostFilters").savedCostFilters;
const scenarios = () => cloudClient("costScenarios").costScenarios;
const businessMetrics = () => cloudClient("businessMetrics").businessMetrics;

/** `?from=&to=`, each only when set (the handlers dropped an empty one). */
function range(from?: string, to?: string) {
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export function queryCloudCosts(
  orgId: string,
  request: CostQueryRequest,
): Promise<CostQueryResponse> {
  return runRpc(costs().query({ params: { orgId }, payload: definedFields(request) }));
}

/**
 * `POST /costs/focus-export`: the FOCUS CSV body as text. `filters` is
 * stated (`[]` when absent), which is what the server's decoding default
 * reads an absent one as.
 */
export function downloadCloudFocusExport(
  orgId: string,
  request: FocusExportRequest,
): Promise<string> {
  return runRpc(
    costs().focusExport({
      params: { orgId },
      payload: definedFields({ ...request, filters: request.filters ?? [] }),
    }),
  );
}

export function loadCloudCostDimensionValues(
  orgId: string,
  dimension: string,
  tagKey?: string,
): Promise<CostDimensionOption[]> {
  return runRpc(
    costs()
      .dimensions({ params: { orgId }, query: { dimension, ...(tagKey ? { tagKey } : {}) } })
      .pipe(
        Effect.map((res) =>
          res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v)),
        ),
      ),
  );
}

export function loadCloudCarbonEstimate(
  orgId: string,
  windowDays?: number,
): Promise<CarbonEstimate> {
  return runRpc(
    cloudClient("carbon").carbon.estimate({
      params: { orgId },
      query: windowDays ? { windowDays: String(windowDays) } : {},
    }),
  );
}

export function loadCloudCostStatus(orgId: string): Promise<CostAccountStatus[]> {
  return runRpc(
    costs()
      .status({ params: { orgId } })
      .pipe(Effect.map((res) => res.accounts)),
  );
}

export function listCloudCostAnomalies(orgId: string, days = 30): Promise<CostAnomaly[]> {
  return runRpc(
    costs()
      .anomalies({ params: { orgId }, query: days ? { days: String(days) } : {} })
      .pipe(Effect.map((res) => res.anomalies)),
  );
}

/**
 * Explain a detected anomaly: records the sentence on the finding and puts it
 * on every cost chart covering the day as an annotation (`costs:write`).
 */
export function acknowledgeCloudCostAnomaly(
  orgId: string,
  anomalyId: string,
  explanation: string,
): Promise<CostAnomaly> {
  return runRpc(
    costs().acknowledgeAnomaly({ params: { orgId, anomalyId }, payload: { explanation } }),
  );
}

/** A budget's alert history, each firing with its note. */
export function listCloudBudgetAlertEvents(
  orgId: string,
  budgetId: string,
): Promise<BudgetAlertEvent[]> {
  return runRpc(budgets().events({ params: { orgId, id: budgetId } }));
}

/** Explain one firing; the server dates the chart marker and posts the follow-up. */
export function annotateCloudBudgetAlert(
  orgId: string,
  budgetId: string,
  eventId: string,
  note: string,
): Promise<BudgetAlertNoteResult> {
  return runRpc(budgets().note({ params: { orgId, id: budgetId, eventId }, payload: { note } }));
}

export function loadCloudAnomalySettings(orgId: string): Promise<CostAnomalySettingsView> {
  return runRpc(costs().anomalySettings({ params: { orgId } }));
}

export function saveCloudAnomalySettings(
  orgId: string,
  settings: CostAnomalySettings,
): Promise<CostAnomalySettingsView> {
  return runRpc(
    costs().updateAnomalySettings({ params: { orgId }, payload: definedFields(settings) }),
  );
}

export function submitCloudAnomalyFeedback(
  orgId: string,
  anomalyId: string,
  input: CostAnomalyFeedbackInput,
): Promise<CostAnomalyFeedbackResult> {
  return runRpc(
    anomalyFeedback().submitFeedback({
      params: { orgId, anomalyId },
      payload: definedFields(input),
    }),
  );
}

export function clearCloudAnomalyFeedback(orgId: string, anomalyId: string): Promise<CostAnomaly> {
  return runRpc(anomalyFeedback().clearFeedback({ params: { orgId, anomalyId } }));
}

export function listCloudAnomalySuppressions(orgId: string): Promise<CostAnomalySuppression[]> {
  return runRpc(
    anomalyFeedback()
      .listSuppressions({ params: { orgId } })
      .pipe(Effect.map((res) => res.suppressions)),
  );
}

export function createCloudAnomalySuppression(
  orgId: string,
  input: CostAnomalySuppressionInput,
): Promise<CostAnomalySuppression> {
  return runRpc(
    anomalyFeedback().createSuppression({ params: { orgId }, payload: definedFields(input) }),
  );
}

export function updateCloudAnomalySuppression(
  orgId: string,
  suppressionId: string,
  input: CostAnomalySuppressionInput,
): Promise<CostAnomalySuppression> {
  return runRpc(
    anomalyFeedback().updateSuppression({
      params: { orgId, suppressionId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudAnomalySuppression(orgId: string, suppressionId: string): Promise<void> {
  return runRpc(
    anomalyFeedback().deleteSuppression({ params: { orgId, suppressionId } }).pipe(Effect.asVoid),
  );
}

export function loadCloudAnomalySensitivity(orgId: string): Promise<CostAnomalySensitivity> {
  return runRpc(anomalyFeedback().sensitivity({ params: { orgId } }));
}

export function loadCloudAnomalyPrecision(
  orgId: string,
  months?: number,
): Promise<CostAnomalyPrecisionReport> {
  return runRpc(
    anomalyFeedback().precision({
      params: { orgId },
      query: months !== undefined && Number.isInteger(months) ? { months: String(months) } : {},
    }),
  );
}

/** The org's cost centres: the costs panels' pickers and the invoice scope picker share it. */
export function listCloudCostCentresForCosts(orgId: string): Promise<CostCentre[]> {
  return runRpc(cloudClient("costCentres").costCentres.list({ params: { orgId } }));
}

export function loadCloudTagPolicy(orgId: string): Promise<TagPolicy> {
  return runRpc(cloudClient("tagPolicy").tagPolicy.get({ params: { orgId } }));
}

export function loadCloudTagCompliance(orgId: string): Promise<TagComplianceReport> {
  return runRpc(cloudClient("tagPolicy").tagPolicy.compliance({ params: { orgId } }));
}

export function loadCloudUntaggedSpend(
  orgId: string,
  from?: string,
  to?: string,
): Promise<UntaggedSpendReport> {
  return runRpc(costs().untagged({ params: { orgId }, query: range(from, to) }));
}

export function loadCloudShowback(
  orgId: string,
  from?: string,
  to?: string,
): Promise<ShowbackReport> {
  return runRpc(costs().showback({ params: { orgId }, query: range(from, to) }));
}

/** The org's billing rules, read-only: see `CostsClient.listBillingRules`. */
export function loadCloudBillingRules(orgId: string): Promise<BillingRule[]> {
  return runRpc(cloudClient("billingRules").billingRules.list({ params: { orgId } }));
}

export function loadCloudCreditBurndown(orgId: string): Promise<CreditBurndown> {
  return runRpc(cloudClient("credits").credits.burndown({ params: { orgId } }));
}

export function loadCloudCommitments(orgId: string): Promise<CommitmentsFeed> {
  return runRpc(cloudClient("commitments").commitments.feed({ params: { orgId } }));
}

export function loadCloudNetworkFlows(
  orgId: string,
  options?: { from?: string; to?: string; scope?: string; limit?: number },
): Promise<NetworkFlowFeed> {
  return runRpc(
    networkFlows().feed({
      params: { orgId },
      query: {
        ...range(options?.from, options?.to),
        ...(options?.scope ? { scope: options.scope } : {}),
        ...(options?.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    }),
  );
}

export function saveCloudNetworkFlowSettings(
  orgId: string,
  settings: { enabled: boolean; initialLookbackDays?: number },
): Promise<{ enabled: boolean; initialLookbackDays: number }> {
  // A toggle that names no lookback leaves it out, which keeps the stored one.
  const { enabled, initialLookbackDays } = settings;
  return runRpc(
    networkFlows().setSettings({
      params: { orgId },
      payload: {
        enabled,
        ...(initialLookbackDays !== undefined ? { initialLookbackDays } : {}),
      },
    }),
  );
}

export function loadCloudKubernetesNetwork(
  orgId: string,
  accountId: string,
  options?: { from?: string; to?: string; limit?: number },
): Promise<KubernetesNetworkReport> {
  return runRpc(
    networkFlows().kubernetes({
      params: { orgId, accountId },
      query: {
        ...range(options?.from, options?.to),
        ...(options?.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    }),
  );
}

export function saveCloudKubernetesNetworkSettings(
  orgId: string,
  accountId: string,
  settings: { billedQuery: string | null },
): Promise<KubernetesNetworkSettings> {
  return runRpc(
    networkFlows().setKubernetesSettings({
      params: { orgId, accountId },
      payload: definedFields(settings),
    }),
  );
}

export function loadCloudRealizedSavings(
  orgId: string,
  window: { from?: string; to?: string } = {},
): Promise<RealizedSavingsReport> {
  return runRpc(savings().realized({ params: { orgId }, query: range(window.from, window.to) }));
}

export function createCloudSavingsEvent(
  orgId: string,
  input: SavingsEventInput,
): Promise<SavingsEvent> {
  return runRpc(savings().createEvent({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudSavingsEvent(
  orgId: string,
  eventId: string,
  input: SavingsEventInput,
): Promise<SavingsEvent> {
  return runRpc(
    savings().updateEvent({ params: { orgId, id: eventId }, payload: definedFields(input) }),
  );
}

export function annotateCloudSavingsEvent(
  orgId: string,
  eventId: string,
  input: SavingsEventAnnotationInput,
): Promise<SavingsEvent> {
  return runRpc(
    savings().annotateEvent({ params: { orgId, id: eventId }, payload: definedFields(input) }),
  );
}

export function deleteCloudSavingsEvent(orgId: string, eventId: string): Promise<void> {
  return runRpc(
    savings()
      .deleteEvent({ params: { orgId, id: eventId } })
      .pipe(Effect.asVoid),
  );
}

export function saveCloudSavingsSettings(
  orgId: string,
  settings: RealizedSavingsSettings,
): Promise<RealizedSavingsSettings> {
  return runRpc(savings().updateSettings({ params: { orgId }, payload: definedFields(settings) }));
}

/**
 * The spotlight index (`GET /search`), resources only: the manual-entry
 * picker, and the service editor's member picker (`cloud-services.ts`).
 */
export function searchCloudResourceIndex(orgId: string, query: string) {
  return cloudClient("search")
    .search.search({ params: { orgId }, query: { q: query } })
    .pipe(Effect.map((rows) => rows.filter((r) => r.pluginId !== "__workflows__")));
}

export function searchCloudSavingsResources(
  orgId: string,
  query: string,
): Promise<SavingsResourceOption[]> {
  // The spotlight index also returns workflows; only resources can be linked.
  return runRpc(searchCloudResourceIndex(orgId, query));
}

export function loadCloudEfficiencyAlerts(
  orgId: string,
  options: { kind?: EfficiencyAlertKind; limit?: number } = {},
): Promise<EfficiencyAlertEvent[]> {
  return runRpc(
    costs()
      .efficiencyAlerts({
        params: { orgId },
        query: {
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.limit ? { limit: String(options.limit) } : {}),
        },
      })
      .pipe(Effect.map((res) => res.events)),
  );
}

export function loadCloudEfficiencySettings(orgId: string): Promise<CostEfficiencySettings> {
  return runRpc(costs().efficiencyAlertSettings({ params: { orgId } }));
}

/** Members, policy and availability for the alert email recipients field. */
export function loadCloudAlertEmailOptions(orgId: string): Promise<AlertEmailOptions> {
  return runRpc(cloudClient("alertEmail").alertEmail.options({ params: { orgId } }));
}

export function saveCloudEfficiencySettings(
  orgId: string,
  settings: CostEfficiencySettings,
): Promise<CostEfficiencySettings> {
  return runRpc(
    costs().updateEfficiencyAlertSettings({ params: { orgId }, payload: definedFields(settings) }),
  );
}

export function listCloudBudgets(orgId: string): Promise<BudgetWithStatus[]> {
  return runRpc(budgets().list({ params: { orgId } }));
}

export function createCloudBudget(orgId: string, input: BudgetInput): Promise<{ id: string }> {
  return runRpc(budgets().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudBudget(
  orgId: string,
  budgetId: string,
  input: BudgetInput,
): Promise<void> {
  return runRpc(
    budgets()
      .update({ params: { orgId, id: budgetId }, payload: definedFields(input) })
      .pipe(Effect.asVoid),
  );
}

export function deleteCloudBudget(orgId: string, budgetId: string): Promise<void> {
  return runRpc(
    budgets()
      .delete({ params: { orgId, id: budgetId } })
      .pipe(Effect.asVoid),
  );
}

/* ------------------------------------------------------------------ *
 * Change-based cost alerts: configured relative change on a scope.
 * ------------------------------------------------------------------ */

export function listCloudCostAlerts(orgId: string): Promise<CostAlert[]> {
  return runRpc(
    costAlerts()
      .list({ params: { orgId } })
      .pipe(Effect.map((res) => res.alerts)),
  );
}

export function listCloudCostAlertEvents(
  orgId: string,
  options: { alertId?: string; limit?: number } = {},
): Promise<CostAlertEvent[]> {
  return runRpc(
    costAlerts()
      .events({
        params: { orgId },
        query: {
          ...(options.alertId ? { alertId: options.alertId } : {}),
          ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
        },
      })
      .pipe(Effect.map((res) => res.events)),
  );
}

export function createCloudCostAlert(orgId: string, input: CostAlertInput): Promise<CostAlert> {
  return runRpc(costAlerts().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudCostAlert(
  orgId: string,
  alertId: string,
  input: CostAlertInput,
): Promise<CostAlert> {
  return runRpc(
    costAlerts().update({ params: { orgId, id: alertId }, payload: definedFields(input) }),
  );
}

export function deleteCloudCostAlert(orgId: string, alertId: string): Promise<void> {
  return runRpc(
    costAlerts()
      .delete({ params: { orgId, id: alertId } })
      .pipe(Effect.asVoid),
  );
}

export function createCloudWidget(
  orgId: string,
  request: { dashboardId: string; kind: DashboardWidgetKind; title?: string; config: unknown },
): Promise<DashboardWidget> {
  const { config } = request;
  if (!Predicate.isObject(config)) return Promise.reject(widgetConfigRefused());
  const payload = {
    dashboardId: request.dashboardId,
    kind: request.kind,
    ...(request.title !== undefined ? { title: request.title } : {}),
    config,
  };
  return runRpc(widgets().create({ params: { orgId }, payload }));
}

export function updateCloudWidget(
  orgId: string,
  widgetId: string,
  request: { title?: string; config?: unknown; gridW?: number; gridH?: number },
): Promise<DashboardWidget> {
  const { config } = request;
  if (config !== undefined && !Predicate.isObject(config)) {
    return Promise.reject(widgetConfigRefused());
  }
  const payload = {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(request.gridW !== undefined ? { gridW: request.gridW } : {}),
    ...(request.gridH !== undefined ? { gridH: request.gridH } : {}),
  };
  return runRpc(widgets().update({ params: { orgId, widgetId }, payload }));
}

/** A widget's config is a JSON object (the endpoint's `JsonObject`); anything else is refused unsent. */
function widgetConfigRefused(): CloudRequestEncodeError {
  return new CloudRequestEncodeError({ message: "A widget config must be a JSON object" });
}

/** Copy a card in place: the server opens the slot after the original. */
export function duplicateCloudWidget(orgId: string, widgetId: string): Promise<DashboardWidget> {
  return runRpc(widgets().duplicate({ params: { orgId, widgetId } }));
}

/** Answer one KPI card's config (`POST /dashboards/kpi`). */
export function evaluateCloudDashboardKpi(
  orgId: string,
  config: KpiWidgetConfig,
): Promise<DashboardKpiResult> {
  return runRpc(widgets().kpi({ params: { orgId }, payload: definedFields({ config }) }));
}

export function deleteCloudWidget(orgId: string, widgetId: string): Promise<void> {
  return runRpc(widgets().delete({ params: { orgId, widgetId } }).pipe(Effect.asVoid));
}

/* ------------------------------------------------------------------ *
 * Cost reports: the named, saved form of a cost graph.
 * ------------------------------------------------------------------ */

/** A report as the endpoints answer it. */
type CostReportWire = Effect.Success<ReturnType<ReturnType<typeof costReports>["get"]>>;

/**
 * A report as the panels hold it. The contract fills four absent `config`
 * keys in when it decodes (`withDecodingDefaultKey`), so its wire type leaves
 * them optional; the same defaults are applied here.
 */
function withReportDefaults(report: CostReportWire): CostReport {
  const { config } = report;
  return {
    ...report,
    config: {
      ...config,
      filters: config.filters ?? [],
      topN: config.topN ?? 5,
      comparePreviousPeriod: config.comparePreviousPeriod ?? false,
      showForecast: config.showForecast ?? false,
    },
  };
}

export function listCloudCostReports(orgId: string): Promise<CostReport[]> {
  return runRpc(
    costReports()
      .list({ params: { orgId } })
      .pipe(Effect.map((rows) => rows.map(withReportDefaults))),
  );
}

export function getCloudCostReport(orgId: string, reportId: string): Promise<CostReport> {
  return runRpc(
    costReports()
      .get({ params: { orgId, id: reportId } })
      .pipe(Effect.map(withReportDefaults)),
  );
}

export function createCloudCostReport(orgId: string, input: CostReportInput): Promise<CostReport> {
  return runRpc(
    costReports()
      .create({ params: { orgId }, payload: definedFields(input) })
      .pipe(Effect.map(withReportDefaults)),
  );
}

export function updateCloudCostReport(
  orgId: string,
  reportId: string,
  input: CostReportInput,
): Promise<CostReport> {
  return runRpc(
    costReports()
      .update({ params: { orgId, id: reportId }, payload: definedFields(input) })
      .pipe(Effect.map(withReportDefaults)),
  );
}

export function deleteCloudCostReport(orgId: string, reportId: string): Promise<void> {
  return runRpc(
    costReports()
      .delete({ params: { orgId, id: reportId } })
      .pipe(Effect.asVoid),
  );
}

/** Move or delete many reports and folders at once; all or nothing server-side. */
export function bulkUpdateCloudCostReports(
  orgId: string,
  request: CostReportBulkRequest,
): Promise<CostReportBulkResult> {
  return runRpc(costReports().bulk({ params: { orgId }, payload: definedFields(request) }));
}

/* ------------------------------------------------------------------ *
 * Cost annotations: dated notes drawn over cost charts. Org-wide unless
 * scoped to a report, which is why these are not report sub-calls.
 * ------------------------------------------------------------------ */

export function listCloudCostAnnotations(
  orgId: string,
  reportId?: string,
): Promise<CostAnnotation[]> {
  return runRpc(
    annotations()
      .list({ params: { orgId }, query: reportId ? { reportId } : {} })
      .pipe(Effect.map((res) => res.annotations)),
  );
}

export function createCloudCostAnnotation(
  orgId: string,
  input: CostAnnotationInput,
): Promise<CostAnnotation> {
  return runRpc(annotations().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudCostAnnotation(
  orgId: string,
  annotationId: string,
  input: CostAnnotationInput,
): Promise<CostAnnotation> {
  return runRpc(
    annotations().update({ params: { orgId, id: annotationId }, payload: definedFields(input) }),
  );
}

export function deleteCloudCostAnnotation(orgId: string, annotationId: string): Promise<void> {
  return runRpc(
    annotations()
      .delete({ params: { orgId, id: annotationId } })
      .pipe(Effect.asVoid),
  );
}

/* ------------------------------------------------------------------ *
 * Cost-report folders: the tree the Reports list groups by.
 * ------------------------------------------------------------------ */

export function listCloudCostReportFolders(orgId: string): Promise<CostReportFolder[]> {
  return runRpc(folders().list({ params: { orgId } }));
}

export function createCloudCostReportFolder(
  orgId: string,
  input: CostReportFolderInput,
): Promise<CostReportFolder> {
  return runRpc(folders().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudCostReportFolder(
  orgId: string,
  folderId: string,
  input: CostReportFolderInput,
): Promise<CostReportFolder> {
  return runRpc(
    folders().update({ params: { orgId, id: folderId }, payload: definedFields(input) }),
  );
}

export function deleteCloudCostReportFolder(orgId: string, folderId: string): Promise<void> {
  return runRpc(
    folders()
      .delete({ params: { orgId, id: folderId } })
      .pipe(Effect.asVoid),
  );
}

/* ------------------------------------------------------------------ *
 * Report delivery schedules: scheduled sends of a saved report to
 * Slack/Teams/email. Cloud-only like everything else here.
 * ------------------------------------------------------------------ */

export function listCloudReportNotifications(
  orgId: string,
  reportId: string,
): Promise<ReportNotification[]> {
  return runRpc(reportDelivery().list({ params: { orgId, id: reportId } }));
}

export function loadCloudReportDeliveryTargets(
  orgId: string,
  reportId: string,
): Promise<ReportDeliveryTargets> {
  return runRpc(reportDelivery().targets({ params: { orgId, id: reportId } }));
}

export function createCloudReportNotification(
  orgId: string,
  reportId: string,
  input: ReportNotificationInput,
): Promise<ReportNotification> {
  return runRpc(
    reportDelivery().create({ params: { orgId, id: reportId }, payload: definedFields(input) }),
  );
}

export function updateCloudReportNotification(
  orgId: string,
  reportId: string,
  notificationId: string,
  input: ReportNotificationInput,
): Promise<ReportNotification> {
  return runRpc(
    reportDelivery().update({
      params: { orgId, id: reportId, notificationId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudReportNotification(
  orgId: string,
  reportId: string,
  notificationId: string,
): Promise<void> {
  return runRpc(
    reportDelivery()
      .delete({ params: { orgId, id: reportId, notificationId } })
      .pipe(Effect.asVoid),
  );
}

export function sendCloudReportNotificationNow(
  orgId: string,
  reportId: string,
  notificationId: string,
): Promise<ReportNotificationSendResult> {
  return runRpc(reportDelivery().send({ params: { orgId, id: reportId, notificationId } }));
}

/* ------------------------------------------------------------------ *
 * PDF export and dashboard delivery schedules. The PDFs come back as bytes
 * over the cloud transport; the caller turns them into a download.
 * ------------------------------------------------------------------ */

export function loadCloudCostReportPdf(orgId: string, reportId: string): Promise<Uint8Array> {
  return runRpc(reportPdf().pdf({ params: { orgId, id: reportId }, query: pdfTimezoneQuery() }));
}

/* Background export jobs (`/costs/exports/jobs`). */

export function createCloudCostExportJob(
  orgId: string,
  request: CostExportJobRequest,
): Promise<CostExportJob> {
  return runRpc(exportJobs().create({ params: { orgId }, payload: definedFields(request) }));
}

export function getCloudCostExportJob(orgId: string, jobId: string): Promise<CostExportJob> {
  return runRpc(exportJobs().get({ params: { orgId, jobId } }));
}

export function listCloudCostExportJobs(orgId: string): Promise<CostExportJob[]> {
  return runRpc(
    exportJobs()
      .list({ params: { orgId } })
      .pipe(Effect.map((res) => res.jobs)),
  );
}

export function cancelCloudCostExportJob(orgId: string, jobId: string): Promise<CostExportJob> {
  return runRpc(exportJobs().cancel({ params: { orgId, jobId } }));
}

/* A report's own anomaly alert (`/cost-reports/{id}/anomaly-alert`). */

export function listCloudReportAnomalyAlerts(orgId: string): Promise<CostReportAnomalyAlert[]> {
  return runRpc(
    reportAnomalyAlerts()
      .orgReportAnomalyAlerts.list({ params: { orgId } })
      .pipe(Effect.map((res) => res.alerts)),
  );
}

export function loadCloudReportAnomalyAlertTargets(
  orgId: string,
  reportId: string,
): Promise<DestinationCatalog> {
  return runRpc(
    reportAnomalyAlerts().costReportAnomalyAlerts.targets({ params: { orgId, id: reportId } }),
  );
}

export function saveCloudReportAnomalyAlert(
  orgId: string,
  reportId: string,
  input: CostReportAnomalyAlertInput,
): Promise<CostReportAnomalyAlert> {
  return runRpc(
    reportAnomalyAlerts().costReportAnomalyAlerts.put({
      params: { orgId, id: reportId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudReportAnomalyAlert(orgId: string, reportId: string): Promise<void> {
  return runRpc(
    reportAnomalyAlerts()
      .costReportAnomalyAlerts.delete({ params: { orgId, id: reportId } })
      .pipe(Effect.asVoid),
  );
}

/**
 * A finished export job's file. The endpoint answers text (CSV or JSON
 * lines, UTF-8), which is written back to the UTF-8 bytes the caller saves.
 */
export function loadCloudCostExportJobFile(orgId: string, jobId: string): Promise<Uint8Array> {
  return runRpc(
    exportJobs()
      .download({ params: { orgId, jobId } })
      .pipe(Effect.map((text) => new TextEncoder().encode(text))),
  );
}

export function loadCloudDashboardPdf(orgId: string, dashboardId: string): Promise<Uint8Array> {
  return runRpc(
    dashboardDelivery().pdf({ params: { orgId, id: dashboardId }, query: pdfTimezoneQuery() }),
  );
}

export function listCloudDashboardNotifications(
  orgId: string,
  dashboardId: string,
): Promise<DashboardNotification[]> {
  return runRpc(dashboardDelivery().list({ params: { orgId, id: dashboardId } }));
}

export function loadCloudDashboardDeliveryTargets(
  orgId: string,
  dashboardId: string,
): Promise<ReportDeliveryTargets> {
  return runRpc(dashboardDelivery().targets({ params: { orgId, id: dashboardId } }));
}

export function createCloudDashboardNotification(
  orgId: string,
  dashboardId: string,
  input: DashboardNotificationInput,
): Promise<DashboardNotification> {
  return runRpc(
    dashboardDelivery().create({
      params: { orgId, id: dashboardId },
      payload: definedFields(input),
    }),
  );
}

export function updateCloudDashboardNotification(
  orgId: string,
  dashboardId: string,
  notificationId: string,
  input: DashboardNotificationInput,
): Promise<DashboardNotification> {
  return runRpc(
    dashboardDelivery().update({
      params: { orgId, id: dashboardId, notificationId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudDashboardNotification(
  orgId: string,
  dashboardId: string,
  notificationId: string,
): Promise<void> {
  return runRpc(
    dashboardDelivery()
      .delete({ params: { orgId, id: dashboardId, notificationId } })
      .pipe(Effect.asVoid),
  );
}

export function sendCloudDashboardNotificationNow(
  orgId: string,
  dashboardId: string,
  notificationId: string,
): Promise<DashboardNotificationSendResult> {
  return runRpc(dashboardDelivery().send({ params: { orgId, id: dashboardId, notificationId } }));
}

/* ------------------------------------------------------------------ *
 * Saved cost filters: named filter sets applied by reference. Cloud-mode
 * only, and resolved server-side at query time like every other surface.
 * ------------------------------------------------------------------ */

export function listCloudSavedCostFilters(orgId: string): Promise<SavedCostFilter[]> {
  return runRpc(savedFilters().list({ params: { orgId } }));
}

export function createCloudSavedCostFilter(
  orgId: string,
  input: SavedCostFilterInput,
): Promise<SavedCostFilter> {
  return runRpc(savedFilters().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudSavedCostFilter(
  orgId: string,
  savedFilterId: string,
  input: SavedCostFilterInput,
): Promise<SavedCostFilter> {
  return runRpc(
    savedFilters().update({ params: { orgId, id: savedFilterId }, payload: definedFields(input) }),
  );
}

/** Rejects with the server's 409 message (naming referents) while referenced. */
export function deleteCloudSavedCostFilter(orgId: string, savedFilterId: string): Promise<void> {
  return runRpc(
    savedFilters()
      .delete({ params: { orgId, id: savedFilterId } })
      .pipe(Effect.asVoid),
  );
}

export function listCloudSavedCostFilterReferents(
  orgId: string,
  savedFilterId: string,
): Promise<SavedCostFilterReferent[]> {
  return runRpc(
    savedFilters()
      .referents({ params: { orgId, id: savedFilterId } })
      .pipe(Effect.map((res) => res.referents)),
  );
}

/* ------------------------------------------------------------------ *
 * Scenario models: named sets of known future cost overlaid on a forecast.
 * Cloud-mode only, and resolved server-side at query time like saved filters.
 * ------------------------------------------------------------------ */

/** A scenario model as the endpoints answer it. */
type CostScenarioModelWire = Effect.Success<ReturnType<ReturnType<typeof scenarios>["get"]>>;

/**
 * A scenario model as the panels hold it. The contract decodes an absent
 * adjustment field to `null` (`scope` to `[]`) with `withDecodingDefaultKey`,
 * so its wire type leaves those keys optional; the same defaults are applied
 * here.
 */
function withAdjustmentDefaults(model: CostScenarioModelWire): CostScenarioModel {
  return {
    ...model,
    adjustments: model.adjustments.map((adjustment) => ({
      ...adjustment,
      endDate: adjustment.endDate ?? null,
      amountCents: adjustment.amountCents ?? null,
      currency: adjustment.currency ?? null,
      period: adjustment.period ?? null,
      percent: adjustment.percent ?? null,
      scope: adjustment.scope ?? [],
    })),
  };
}

export function listCloudCostScenarioModels(orgId: string): Promise<CostScenarioModel[]> {
  return runRpc(
    scenarios()
      .list({ params: { orgId } })
      .pipe(Effect.map((res) => res.models.map(withAdjustmentDefaults))),
  );
}

export function createCloudCostScenarioModel(
  orgId: string,
  input: CostScenarioModelInput,
): Promise<CostScenarioModel> {
  return runRpc(
    scenarios()
      .create({ params: { orgId }, payload: definedFields(input) })
      .pipe(Effect.map(withAdjustmentDefaults)),
  );
}

export function updateCloudCostScenarioModel(
  orgId: string,
  modelId: string,
  input: CostScenarioModelInput,
): Promise<CostScenarioModel> {
  return runRpc(
    scenarios()
      .update({ params: { orgId, id: modelId }, payload: definedFields(input) })
      .pipe(Effect.map(withAdjustmentDefaults)),
  );
}

/** Rejects with the server's 409 message (naming referents) while referenced. */
export function deleteCloudCostScenarioModel(orgId: string, modelId: string): Promise<void> {
  return runRpc(
    scenarios()
      .delete({ params: { orgId, id: modelId } })
      .pipe(Effect.asVoid),
  );
}

export function listCloudCostScenarioReferents(
  orgId: string,
  modelId: string,
): Promise<CostScenarioReferent[]> {
  return runRpc(
    scenarios()
      .referents({ params: { orgId, id: modelId } })
      .pipe(Effect.map((res) => res.referents)),
  );
}

/* ------------------------------------------------------------------ *
 * Business metrics and unit costs. Cloud-mode only like the rest of this
 * module: the numerator lives in the cloud's cost store, so there is no
 * local-SQLite equivalent to fall back to.
 * ------------------------------------------------------------------ */

export function listCloudBusinessMetrics(orgId: string): Promise<BusinessMetric[]> {
  return runRpc(
    businessMetrics()
      .list({ params: { orgId } })
      .pipe(Effect.map((res) => res.metrics)),
  );
}

export function createCloudBusinessMetric(
  orgId: string,
  input: BusinessMetricInput,
): Promise<BusinessMetric> {
  return runRpc(businessMetrics().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudBusinessMetric(
  orgId: string,
  metricId: string,
  input: BusinessMetricInput,
): Promise<BusinessMetric> {
  return runRpc(
    businessMetrics().update({ params: { orgId, id: metricId }, payload: definedFields(input) }),
  );
}

export function deleteCloudBusinessMetric(orgId: string, metricId: string): Promise<void> {
  return runRpc(
    businessMetrics()
      .delete({ params: { orgId, id: metricId } })
      .pipe(Effect.asVoid),
  );
}

export function listCloudBusinessMetricValues(
  orgId: string,
  metricId: string,
  limit?: number,
): Promise<BusinessMetricValue[]> {
  return runRpc(
    businessMetrics()
      .values({ params: { orgId, id: metricId }, query: { limit: String(limit ?? 90) } })
      .pipe(Effect.map((res) => res.values)),
  );
}

export function writeCloudBusinessMetricValues(
  orgId: string,
  metricId: string,
  values: BusinessMetricValueInput[],
): Promise<BusinessMetricWriteResult> {
  return runRpc(
    businessMetrics().writeValues({
      params: { orgId, id: metricId },
      payload: definedFields({ values }),
    }),
  );
}

export function listCloudBusinessMetricForecastValues(
  orgId: string,
  metricId: string,
): Promise<BusinessMetricForecastValue[]> {
  return runRpc(
    businessMetrics()
      .forecastValues({ params: { orgId, id: metricId }, query: {} })
      .pipe(Effect.map((res) => res.values)),
  );
}

export function writeCloudBusinessMetricForecastValues(
  orgId: string,
  metricId: string,
  values: BusinessMetricForecastValueInput[],
): Promise<{ written: number }> {
  return runRpc(
    businessMetrics().writeForecastValues({
      params: { orgId, id: metricId },
      payload: definedFields({ values }),
    }),
  );
}

export function deleteCloudBusinessMetricForecastValues(
  orgId: string,
  metricId: string,
  window: { from?: string; to?: string },
): Promise<{ deleted: number }> {
  return runRpc(
    businessMetrics().deleteForecastValues({
      params: { orgId, id: metricId },
      query: range(window.from, window.to),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Named forecasts on a cost report.
 * ------------------------------------------------------------------ */

export function listCloudCostForecasts(orgId: string, reportId: string): Promise<CostForecast[]> {
  return runRpc(
    costForecasts()
      .list({ params: { orgId, id: reportId } })
      .pipe(Effect.map((res) => res.forecasts)),
  );
}

export function runCloudCostForecast(
  orgId: string,
  reportId: string,
  request: CostForecastRunRequest,
): Promise<CostForecastResult> {
  return runRpc(
    costForecasts().forecastedCosts({
      params: { orgId, id: reportId },
      payload: definedFields(request),
    }),
  );
}

export function createCloudCostForecast(
  orgId: string,
  reportId: string,
  input: CostForecastInput,
): Promise<CostForecast> {
  return runRpc(
    costForecasts().create({ params: { orgId, id: reportId }, payload: definedFields(input) }),
  );
}

export function updateCloudCostForecast(
  orgId: string,
  reportId: string,
  forecastId: string,
  input: CostForecastInput,
): Promise<CostForecast> {
  return runRpc(
    costForecasts().update({
      params: { orgId, id: reportId, forecastId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudCostForecast(
  orgId: string,
  reportId: string,
  forecastId: string,
): Promise<void> {
  return runRpc(
    costForecasts()
      .delete({ params: { orgId, id: reportId, forecastId } })
      .pipe(Effect.asVoid),
  );
}

export function listCloudBusinessMetricSources(
  orgId: string,
): Promise<BusinessMetricSourceAccount[]> {
  return runRpc(
    businessMetrics()
      .importerSources({ params: { orgId } })
      .pipe(Effect.map((res) => res.sources)),
  );
}

export function listCloudBusinessMetricSourceOptions(
  orgId: string,
  request: BusinessMetricSourceOptionsRequest,
): Promise<BusinessMetricSourceOption[]> {
  return runRpc(
    businessMetrics()
      .importerOptions({ params: { orgId }, payload: definedFields(request) })
      .pipe(Effect.map((res) => res.options)),
  );
}

export function previewCloudBusinessMetricImport(
  orgId: string,
  request: BusinessMetricImportPreviewRequest,
): Promise<BusinessMetricImportPreview> {
  return runRpc(
    businessMetrics().importerPreview({ params: { orgId }, payload: definedFields(request) }),
  );
}

export function getCloudBusinessMetricImporter(
  orgId: string,
  metricId: string,
): Promise<BusinessMetricImporter | null> {
  return runRpc(
    businessMetrics()
      .importer({ params: { orgId, id: metricId } })
      .pipe(Effect.map((res) => res.importer ?? null)),
  );
}

export function saveCloudBusinessMetricImporter(
  orgId: string,
  metricId: string,
  input: BusinessMetricImporterInput,
): Promise<BusinessMetricImporter> {
  return runRpc(
    businessMetrics().saveImporter({
      params: { orgId, id: metricId },
      payload: definedFields(input),
    }),
  );
}

export function deleteCloudBusinessMetricImporter(orgId: string, metricId: string): Promise<void> {
  return runRpc(
    businessMetrics()
      .deleteImporter({ params: { orgId, id: metricId } })
      .pipe(Effect.asVoid),
  );
}

export function runCloudBusinessMetricImporter(
  orgId: string,
  metricId: string,
  request?: BusinessMetricImportRunRequest,
): Promise<BusinessMetricImportRun> {
  return runRpc(
    businessMetrics().runImporter({
      params: { orgId, id: metricId },
      payload: definedFields(request ?? {}),
    }),
  );
}

export function listCloudBusinessMetricImportRuns(
  orgId: string,
  metricId: string,
  limit?: number,
): Promise<BusinessMetricImportRun[]> {
  return runRpc(
    businessMetrics()
      .importRuns({ params: { orgId, id: metricId }, query: { limit: String(limit ?? 20) } })
      .pipe(Effect.map((res) => res.runs)),
  );
}

export function queryCloudUnitCosts(
  orgId: string,
  metricId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  return runRpc(
    businessMetrics().unitCosts({
      params: { orgId, id: metricId },
      payload: definedFields(request),
    }),
  );
}

export function queryCloudUsageUnitCosts(
  orgId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  return runRpc(
    businessMetrics().usageUnitCosts({ params: { orgId }, payload: definedFields(request) }),
  );
}

export function listCloudUsageUnits(
  orgId: string,
): Promise<Array<{ unit: string; usage: number; services: string[] }>> {
  return runRpc(
    businessMetrics()
      .usageUnits({ params: { orgId } })
      .pipe(Effect.map((res) => res.units)),
  );
}

export function listCloudBusinessMetricLabels(
  orgId: string,
  metricId: string,
): Promise<BusinessMetricLabelSummary[]> {
  return runRpc(
    businessMetrics()
      .labels({ params: { orgId, id: metricId } })
      .pipe(Effect.map((res) => res.labels)),
  );
}

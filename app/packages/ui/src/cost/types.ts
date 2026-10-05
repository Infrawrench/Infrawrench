import type {
  BillingRule,
  BudgetAlertEvent,
  BudgetAlertNoteResult,
  CarbonEstimate,
  BudgetWithStatus,
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostAlertInput,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostAnomalyFeedbackInput,
  CostAnomalyFeedbackResult,
  CostAnomalyPrecisionReport,
  CostAnomalySensitivity,
  CostAnomalySuppression,
  CostAnomalySuppressionInput,
  CostEfficiencySettings,
  EfficiencyAlertEvent,
  EfficiencyAlertKind,
  CommitmentsFeed,
  CostDimensionOption,
  KubernetesNetworkReport,
  KubernetesNetworkSettings,
  NetworkFlowFeed,
  CreditBurndown,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core";
import type {
  BudgetInput,
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
  CostAnnotation,
  CostAnnotationInput,
  CostQueryRequest,
  CostQueryResponse,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
  SavedCostFilter,
  SavedCostFilterInput,
  SavedCostFilterReferent,
  CostScenarioModel,
  CostScenarioModelInput,
  CostScenarioReferent,
} from "./config.js";

/**
 * The cost contract lives in client-core so mobile (which doesn't depend on
 * this package) shares one definition of it; re-exported for web and desktop.
 */
export type {
  CarbonEstimate,
  CommitmentsFeed,
  CreditBurndown,
  BudgetWithStatus,
  BudgetPlacement,
  /** A detected spend anomaly, as listed on the Costs panel. */
  CostAnomaly,
  /** Priced source→destination network flow attribution, one screen's worth. */
  NetworkFlowFeed,
  NetworkFlowPairView,
  NetworkFlowScopeSummary,
  NetworkFlowAccountStatus,
  NetworkFlowScope,
  /** One Kubernetes cluster's network costs by namespace, workload and boundary. */
  KubernetesNetworkReport,
  KubernetesNetworkRow,
  KubernetesNetworkSettings,
  CostAnomalyDimension,
  CostAnomalyKind,
  /** One firing of an efficiency detector, as listed on the Costs panel. */
  EfficiencyAlertEvent,
  EfficiencyAlertKind,
} from "@infrawrench/client-core";
// The rest of the cost/tag-policy contract (CostAccountStatus, the anomaly
// settings, ShowbackReport, TagComplianceReport, …) is re-exported by
// `./config.js`, which shares this barrel: re-exporting the same names from
// two modules makes the bundled d.ts drop them from `export *` as ambiguous.

/**
 * Host-injected data access for the cost components. Web wraps `apiFetch`;
 * desktop (cloud mode) wraps its cloud-api helpers: the components stay
 * platform-agnostic.
 */
export interface CostApi {
  queryCosts(req: CostQueryRequest): Promise<CostQueryResponse>;
  /** `dimension` also accepts "tag-keys" to list tag keys. */
  loadDimensionValues(dimension: string, tagKey?: string): Promise<CostDimensionOption[]>;
  /** Per-account collection state: backs {@link CostAccountStatus} notices. */
  loadCostStatus(): Promise<CostAccountStatus[]>;
  /**
   * The org's saved cost filters, for the picker in {@link CostFilterEditor}.
   * Optional the way the mutating budget calls are: a host that hasn't wired
   * the endpoint simply doesn't offer the picker, and the editor renders
   * exactly as it did before saved filters existed.
   */
  listSavedFilters?(): Promise<SavedCostFilter[]>;
  /** "Save these rows as a filter…" in the editor. Omitted for read-only hosts. */
  createSavedFilter?(input: SavedCostFilterInput): Promise<SavedCostFilter>;
  /**
   * The org's scenario models, for the picker in the graph editor and for
   * naming an applied scenario on a card.
   *
   * On the base `CostApi` rather than on {@link CostsClient} because a card
   * drawing a scenario is a `cost_graph` widget like any other: it renders on a
   * dashboard, on a saved report and on the Costs panel, and all three go
   * through the same component. Optional the way `listSavedFilters` is: a host
   * that hasn't wired it simply doesn't offer scenarios.
   */
  listScenarioModels?(): Promise<CostScenarioModel[]>;
  /**
   * Estimated operational carbon. Optional like the other later additions:
   * a host that does not offer it simply gets no carbon section, rather than
   * a section that fails to load.
   */
  getCarbonEstimate?(): Promise<CarbonEstimate>;
  /**
   * The dated notes a chart should draw. Lives on the base `CostApi` rather
   * than on the report client because an annotation with no report id is
   * org-wide: it belongs on the ad-hoc dashboard cost card just as much as on a
   * saved report, and every one of those renders through {@link CostGraphCard}.
   *
   * Optional the way `listSavedFilters` is: a host that hasn't wired it draws
   * the chart exactly as it did before annotations existed.
   */
  listCostAnnotations?(reportId?: string): Promise<CostAnnotation[]>;
  /**
   * The mutating half. Omitted, the markers render read-only rather than
   * offering controls that fail on click: the same stance the budget half of
   * {@link CostsClient} takes.
   */
  createCostAnnotation?(input: CostAnnotationInput): Promise<CostAnnotation>;
  updateCostAnnotation?(annotationId: string, input: CostAnnotationInput): Promise<CostAnnotation>;
  deleteCostAnnotation?(annotationId: string): Promise<void>;
  /**
   * The org's business metrics, for the unit-cost picker in the graph editor
   * and for naming the denominator on a card.
   *
   * On the base `CostApi` rather than on {@link CostsClient} because a
   * unit-cost graph is a `cost_graph` widget like any other: it renders on a
   * dashboard, on a saved report and on the Costs panel, and all three go
   * through {@link CostGraphCard}. Optional the way `listSavedFilters` is: a
   * host that hasn't wired it simply doesn't offer unit costs.
   */
  listBusinessMetrics?(): Promise<BusinessMetric[]>;
  /**
   * Spend divided by a metric. Separate from `queryCosts` because the answer is
   * a different shape: points can be `null` (a period with no reported value is
   * a gap, never a zero), and there are no groups to stack.
   */
  queryUnitCosts?(metricId: string, request: UnitCostQueryRequest): Promise<UnitCostQueryResponse>;
  /**
   * Spend ÷ provider-reported usage in one unit: the metric-free calculation.
   * Optional like the rest: without it the editor does not offer that mode.
   */
  queryUsageUnitCosts?(request: UnitCostQueryRequest): Promise<UnitCostQueryResponse>;
  /** The usage units the org's cost rows carry, for the per-usage-unit picker. */
  listUsageUnits?(): Promise<Array<{ unit: string; usage: number; services: string[] }>>;
  /** A metric's label keys, values and mappings, for the label filter and group-by pickers. */
  listBusinessMetricLabels?(metricId: string): Promise<BusinessMetricLabelSummary[]>;
}

/** A dashboard a budget card can be added to, for the Costs panel's picker. */
export interface CostsPanelDashboard {
  id: string;
  name: string;
}

/**
 * Everything {@link CostsPanel} needs beyond {@link CostApi}: budget CRUD and
 * the dashboard-placement calls behind "show on a dashboard".
 *
 * Hosts supply this the way they supply `WorkflowClient` / `AgentClient`: web
 * over `apiFetch`, desktop over its cloud-api helpers. A host that cannot edit
 * (or a viewer without `budgets:write`) omits the mutating half, and the panel
 * renders read-only rather than showing controls that fail on click.
 */
export interface CostsClient extends CostApi {
  listBudgets(): Promise<BudgetWithStatus[]>;
  /**
   * Spend anomalies detected over the last `days` days (default 30). Optional
   * the way the mutating half is: a host that hasn't wired the endpoint yet
   * simply doesn't render the anomalies section.
   */
  listAnomalies?(days?: number): Promise<CostAnomaly[]>;
  /**
   * Explain a finding: record what it was, and put that sentence on every cost
   * chart covering the day as an annotation. Answers the updated anomaly.
   *
   * Optional on the usual rule: a host that hasn't wired it renders the
   * anomalies list without the "Explain" action, exactly as it looked before
   * this existed, rather than offering a button that can only fail. The server
   * still enforces `costs:write`.
   */
  acknowledgeAnomaly?(anomalyId: string, explanation: string): Promise<CostAnomaly>;
  /**
   * The org's detection thresholds, plus the derived `smsConfigured` fact the
   * SMS control needs to tell the truth about what turning it on would do.
   * Optional like `listAnomalies`; a host that hasn't wired it shows the list
   * without the tuning controls.
   */
  getAnomalySettings?(): Promise<CostAnomalySettingsView>;
  /**
   * Save the thresholds. Takes the stored settings only: `smsConfigured` is
   * derived server-side and is not the caller's to set. Omitted for a viewer
   * without `costs:write`, and the controls then render read-only rather than
   * failing on save: the same rule the budget half of this client follows.
   */
  updateAnomalySettings?(settings: CostAnomalySettings): Promise<CostAnomalySettingsView>;
  /**
   * Anomaly feedback: mark a finding expected or unexpected, optionally
   * creating a suppression, and withdraw it again. Optional on the usual
   * rule: a host that hasn't wired them renders the list without the
   * Expected/Unexpected actions. The server enforces `costs:write`.
   */
  submitAnomalyFeedback?(
    anomalyId: string,
    input: CostAnomalyFeedbackInput,
  ): Promise<CostAnomalyFeedbackResult>;
  clearAnomalyFeedback?(anomalyId: string): Promise<CostAnomaly>;
  /**
   * The suppression list in the tuning panel. The list alone renders it
   * read-only; the mutating three add the editor.
   */
  listAnomalySuppressions?(): Promise<CostAnomalySuppression[]>;
  createAnomalySuppression?(input: CostAnomalySuppressionInput): Promise<CostAnomalySuppression>;
  updateAnomalySuppression?(
    suppressionId: string,
    input: CostAnomalySuppressionInput,
  ): Promise<CostAnomalySuppression>;
  deleteAnomalySuppression?(suppressionId: string): Promise<void>;
  /** Which keys feedback has moved, and why: shown in the tuning panel. */
  getAnomalySensitivity?(): Promise<CostAnomalySensitivity>;
  /** Precision over time (share of reviewed findings marked unexpected). */
  getAnomalyPrecision?(months?: number): Promise<CostAnomalyPrecisionReport>;
  /** Cost centres, for the suppression scope picker. */
  listCostCentres?(): Promise<Array<{ id: string; name: string }>>;
  /**
   * Change-based cost alerts: the third alert family (configured relative
   * change on a chosen scope and cadence, vs budgets' absolute totals and
   * anomalies' unconfigured outliers). Optional like `listAnomalies`: a host
   * that hasn't wired it doesn't render the change-alerts section, and a
   * viewer without `costs:write` gets the list without the editing half.
   */
  listCostAlerts?(): Promise<CostAlert[]>;
  /** Recently fired change-alert events, newest first. */
  listCostAlertEvents?(options?: { alertId?: string; limit?: number }): Promise<CostAlertEvent[]>;
  createCostAlert?(input: CostAlertInput): Promise<CostAlert>;
  updateCostAlert?(alertId: string, input: CostAlertInput): Promise<CostAlert>;
  deleteCostAlert?(alertId: string): Promise<void>;
  listDashboards(): Promise<CostsPanelDashboard[]>;
  createBudget?(input: BudgetInput): Promise<{ id: string }>;
  updateBudget?(budgetId: string, input: BudgetInput): Promise<void>;
  deleteBudget?(budgetId: string): Promise<void>;
  /** Add a budget card for `budgetId` to `dashboardId`. */
  addBudgetToDashboard?(dashboardId: string, budgetId: string, title: string): Promise<void>;
  /** Remove one budget card, identified by the widget id from `placements`. */
  removeBudgetPlacement?(widgetId: string): Promise<void>;
  /**
   * A budget's alert history with each firing's note (`GET /budgets/:id/events`).
   * Optional: without it the budget card shows only this month's firings.
   */
  listBudgetAlertEvents?(budgetId: string): Promise<BudgetAlertEvent[]>;
  /**
   * Explain one firing: saved on the alert, drawn on the charts at the day it
   * fired, and posted after the alert in Slack (thread reply) and Teams.
   * Optional: without it the card shows notes but offers no composer. The
   * server enforces `costs:write`.
   */
  annotateBudgetAlert?(
    budgetId: string,
    eventId: string,
    note: string,
  ): Promise<BudgetAlertNoteResult>;
  /**
   * Tag governance reads, optional the way `listAnomalies` is: a host that
   * hasn't wired them simply doesn't render the tag governance section.
   * `getTagCompliance` also carries the policy, so one call answers both
   * "what is required" and "who complies".
   */
  getTagCompliance?(): Promise<TagComplianceReport>;
  /** Untagged spend over the required keys; dates are inclusive YYYY-MM-DD. */
  getUntaggedSpend?(from?: string, to?: string): Promise<UntaggedSpendReport>;
  /** Spend grouped by cost centre through the org's allocation rules. */
  getShowback?(from?: string, to?: string): Promise<ShowbackReport>;
  /**
   * The org's billing rules: read-only here, on purpose.
   *
   * The panel only needs to know **whether any rule is in force**, so it can
   * decide whether offering an "Apply billing rules" toggle over the overview
   * chart means anything. Management lives in Settings → Billing Rules, behind
   * `org:settings:write`: a markup changes every figure the org reports about
   * itself, which is a governance act rather than a cost-object edit, and two
   * editors for one thing is how the two disagree.
   *
   * Optional like every other method here: a host that hasn't wired it simply
   * never shows the toggle, and the panel shows collected spend. That is the
   * safe direction to degrade in.
   */
  listBillingRules?(): Promise<BillingRule[]>;
  /**
   * Prepaid credit balances with their burn rate and runway. Optional the way
   * `listAnomalies` is: a host that hasn't wired it simply doesn't render the
   * burndown section, and the section renders nothing anyway for an org with
   * no credit-capable accounts, which is the common case.
   */
  getCreditBurndown?(): Promise<CreditBurndown>;
  /**
   * Commitments (reservations, savings plans, committed-use discounts)
   * with coverage, utilization and planner recommendations. Optional the way
   * `getCreditBurndown` is: an unwired host doesn't render the section, and
   * the section renders nothing anyway for an org with no commitment-capable
   * accounts.
   */
  getCommitments?(): Promise<CommitmentsFeed | null>;
  /**
   * Priced source→destination network flow attribution: the egress and
   * cross-zone story the cost dimensions cannot tell, because every cost
   * dimension is about one side of a transfer and a network charge is about a
   * pair.
   *
   * Optional the way `getCommitments` is: an unwired host doesn't render the
   * section, and the section renders an explanatory empty state (never zero)
   * for an org whose providers cannot report flows at all.
   */
  getNetworkFlows?(options?: {
    from?: string;
    to?: string;
    scope?: string;
    limit?: number;
  }): Promise<NetworkFlowFeed>;
  /**
   * Turn flow collection on or off for the org.
   *
   * Omitted for a viewer without `org:settings:write`, and the switch then
   * renders read-only rather than failing on click: the same rule the budget
   * and anomaly-settings halves of this client follow. The permission is the
   * org-settings one rather than `costs:write` because enabling collection
   * authorizes daily queries the *provider bills to the org's own cloud
   * account*, which is a governance act rather than a cost-object edit.
   */
  updateNetworkFlowSettings?(settings: {
    enabled: boolean;
    initialLookbackDays?: number;
  }): Promise<{ enabled: boolean; initialLookbackDays: number }>;
  /**
   * One Kubernetes cluster's network costs: bytes by namespace, workload and
   * boundary, with its billed data transfer apportioned when a billed source is
   * set. Optional like the rest: an unwired host renders no section.
   */
  getKubernetesNetwork?(
    accountId: string,
    options?: { from?: string; to?: string; limit?: number },
  ): Promise<KubernetesNetworkReport>;
  /**
   * Save the cluster's billed data-transfer source (cost query text, or null to
   * clear). Omitted for a viewer without `costs:write`; the editor then renders
   * read-only.
   */
  updateKubernetesNetworkSettings?(
    accountId: string,
    settings: { billedQuery: string | null },
  ): Promise<KubernetesNetworkSettings>;
  /**
   * The three efficiency alerts (commitment expiry, idle commitments,
   * unit-cost regression) in one feed, newest first. Optional the way
   * `listAnomalies` is: an unwired host doesn't render the section.
   */
  listEfficiencyAlerts?(options?: {
    kind?: EfficiencyAlertKind;
    limit?: number;
  }): Promise<EfficiencyAlertEvent[]>;
  /** The org's tuning for those three detectors; defaults when never saved. */
  getEfficiencyAlertSettings?(): Promise<CostEfficiencySettings>;
  /**
   * Save the tuning. Omitted for a viewer without `costs:write`, and the
   * controls then render read-only rather than failing on save: the same rule
   * `updateAnomalySettings` follows.
   */
  updateEfficiencyAlertSettings?(settings: CostEfficiencySettings): Promise<CostEfficiencySettings>;
  /**
   * Saved-filter management, for the Saved filters section of the Costs panel.
   * The read half (`listSavedFilters`) lives on {@link CostApi} because the
   * filter editors need it too; these are the management-only calls. All
   * optional on the usual rule: omitted, the section renders read-only (or not
   * at all when even the list is unavailable).
   */
  updateSavedFilter?(savedFilterId: string, input: SavedCostFilterInput): Promise<SavedCostFilter>;
  /**
   * Rejects while the filter is referenced: the server answers 409 with the
   * referents, and the thrown error's message names them.
   */
  deleteSavedFilter?(savedFilterId: string): Promise<void>;
  /** Everything referencing a saved filter (budgets, reports, dashboard graphs). */
  getSavedFilterReferents?(savedFilterId: string): Promise<SavedCostFilterReferent[]>;
  /**
   * Scenario-model management, for the Scenario models section of the Costs
   * panel. The read half (`listScenarioModels`) lives on {@link CostApi}
   * because the graph editor needs it too; these are the management-only calls,
   * all optional on the usual rule: omitted, the section renders read-only.
   */
  createScenarioModel?(input: CostScenarioModelInput): Promise<CostScenarioModel>;
  updateScenarioModel?(modelId: string, input: CostScenarioModelInput): Promise<CostScenarioModel>;
  /**
   * Rejects while the model is referenced: the server answers 409 with the
   * referents, and the thrown error's message names them.
   */
  deleteScenarioModel?(modelId: string): Promise<void>;
  /** Everything referencing a model (budgets first: they page people). */
  getScenarioModelReferents?(modelId: string): Promise<CostScenarioReferent[]>;
  /**
   * Business-metric management, for the Unit costs section of the Costs panel.
   * The read half (`listBusinessMetrics`) lives on {@link CostApi} because the
   * graph editor needs it too; these are the management-only calls. All
   * optional on the usual rule: omitted, the section renders read-only.
   */
  createBusinessMetric?(input: BusinessMetricInput): Promise<BusinessMetric>;
  updateBusinessMetric?(metricId: string, input: BusinessMetricInput): Promise<BusinessMetric>;
  deleteBusinessMetric?(metricId: string): Promise<void>;
  /** A metric's reported days, newest first: the "is this being fed?" answer. */
  listBusinessMetricValues?(metricId: string, limit?: number): Promise<BusinessMetricValue[]>;
  /**
   * Report days by hand. Re-reporting a day restates it rather than adding to
   * it, the same guarantee the API and `infra.businessMetrics.write` give.
   */
  writeBusinessMetricValues?(
    metricId: string,
    values: BusinessMetricValueInput[],
  ): Promise<BusinessMetricWriteResult>;
  /**
   * Scheduled importers. Each is optional on the usual rule: the importer
   * editor renders only when the host wires the source list and the save.
   */
  listBusinessMetricSources?(): Promise<BusinessMetricSourceAccount[]>;
  listBusinessMetricSourceOptions?(
    request: BusinessMetricSourceOptionsRequest,
  ): Promise<BusinessMetricSourceOption[]>;
  previewBusinessMetricImport?(
    request: BusinessMetricImportPreviewRequest,
  ): Promise<BusinessMetricImportPreview>;
  getBusinessMetricImporter?(metricId: string): Promise<BusinessMetricImporter | null>;
  saveBusinessMetricImporter?(
    metricId: string,
    input: BusinessMetricImporterInput,
  ): Promise<BusinessMetricImporter>;
  deleteBusinessMetricImporter?(metricId: string): Promise<void>;
  runBusinessMetricImporter?(
    metricId: string,
    request?: BusinessMetricImportRunRequest,
  ): Promise<BusinessMetricImportRun>;
  listBusinessMetricImportRuns?(
    metricId: string,
    limit?: number,
  ): Promise<BusinessMetricImportRun[]>;
}

import type {
  BudgetWithStatus,
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostAlertInput,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CommitmentsFeed,
  CostDimensionOption,
  CreditBurndown,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core";
import type {
  BudgetInput,
  BusinessMetric,
  BusinessMetricInput,
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
  CommitmentsFeed,
  CreditBurndown,
  BudgetWithStatus,
  BudgetPlacement,
  /** A detected spend anomaly, as listed on the Costs panel. */
  CostAnomaly,
  CostAnomalyDimension,
  CostAnomalyKind,
} from "@infrawrench/client-core";
// The rest of the cost/tag-policy contract (CostAccountStatus, the anomaly
// settings, ShowbackReport, TagComplianceReport, …) is re-exported by
// `./config.js`, which shares this barrel — re-exporting the same names from
// two modules makes the bundled d.ts drop them from `export *` as ambiguous.

/**
 * Host-injected data access for the cost components. Web wraps `apiFetch`;
 * desktop (cloud mode) wraps its cloud-api helpers — the components stay
 * platform-agnostic.
 */
export interface CostApi {
  queryCosts(req: CostQueryRequest): Promise<CostQueryResponse>;
  /** `dimension` also accepts "tag-keys" to list tag keys. */
  loadDimensionValues(dimension: string, tagKey?: string): Promise<CostDimensionOption[]>;
  /** Per-account collection state — backs {@link CostAccountStatus} notices. */
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
   * through the same component. Optional the way `listSavedFilters` is — a host
   * that hasn't wired it simply doesn't offer scenarios.
   */
  listScenarioModels?(): Promise<CostScenarioModel[]>;
  /**
   * The dated notes a chart should draw. Lives on the base `CostApi` rather
   * than on the report client because an annotation with no report id is
   * org-wide: it belongs on the ad-hoc dashboard cost card just as much as on a
   * saved report, and every one of those renders through {@link CostGraphCard}.
   *
   * Optional the way `listSavedFilters` is — a host that hasn't wired it draws
   * the chart exactly as it did before annotations existed.
   */
  listCostAnnotations?(reportId?: string): Promise<CostAnnotation[]>;
  /**
   * The mutating half. Omitted, the markers render read-only rather than
   * offering controls that fail on click — the same stance the budget half of
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
   * through {@link CostGraphCard}. Optional the way `listSavedFilters` is — a
   * host that hasn't wired it simply doesn't offer unit costs.
   */
  listBusinessMetrics?(): Promise<BusinessMetric[]>;
  /**
   * Spend divided by a metric. Separate from `queryCosts` because the answer is
   * a different shape: points can be `null` (a period with no reported value is
   * a gap, never a zero), and there are no groups to stack.
   */
  queryUnitCosts?(metricId: string, request: UnitCostQueryRequest): Promise<UnitCostQueryResponse>;
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
 * Hosts supply this the way they supply `WorkflowClient` / `AgentClient` — web
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
   * The org's detection thresholds, plus the derived `smsConfigured` fact the
   * SMS control needs to tell the truth about what turning it on would do.
   * Optional like `listAnomalies`; a host that hasn't wired it shows the list
   * without the tuning controls.
   */
  getAnomalySettings?(): Promise<CostAnomalySettingsView>;
  /**
   * Save the thresholds. Takes the stored settings only — `smsConfigured` is
   * derived server-side and is not the caller's to set. Omitted for a viewer
   * without `costs:write`, and the controls then render read-only rather than
   * failing on save — the same rule the budget half of this client follows.
   */
  updateAnomalySettings?(settings: CostAnomalySettings): Promise<CostAnomalySettingsView>;
  /**
   * Change-based cost alerts — the third alert family (configured relative
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
   * Prepaid credit balances with their burn rate and runway. Optional the way
   * `listAnomalies` is: a host that hasn't wired it simply doesn't render the
   * burndown section — and the section renders nothing anyway for an org with
   * no credit-capable accounts, which is the common case.
   */
  getCreditBurndown?(): Promise<CreditBurndown>;
  /**
   * Commitments — reservations, savings plans, committed-use discounts —
   * with coverage, utilization and planner recommendations. Optional the way
   * `getCreditBurndown` is: an unwired host doesn't render the section, and
   * the section renders nothing anyway for an org with no commitment-capable
   * accounts.
   */
  getCommitments?(): Promise<CommitmentsFeed | null>;
  /**
   * Saved-filter management, for the Saved filters section of the Costs panel.
   * The read half (`listSavedFilters`) lives on {@link CostApi} because the
   * filter editors need it too; these are the management-only calls. All
   * optional on the usual rule: omitted, the section renders read-only (or not
   * at all when even the list is unavailable).
   */
  updateSavedFilter?(savedFilterId: string, input: SavedCostFilterInput): Promise<SavedCostFilter>;
  /**
   * Rejects while the filter is referenced — the server answers 409 with the
   * referents, and the thrown error's message names them.
   */
  deleteSavedFilter?(savedFilterId: string): Promise<void>;
  /** Everything referencing a saved filter (budgets, reports, dashboard graphs). */
  getSavedFilterReferents?(savedFilterId: string): Promise<SavedCostFilterReferent[]>;
  /**
   * Scenario-model management, for the Scenario models section of the Costs
   * panel. The read half (`listScenarioModels`) lives on {@link CostApi}
   * because the graph editor needs it too; these are the management-only calls,
   * all optional on the usual rule — omitted, the section renders read-only.
   */
  createScenarioModel?(input: CostScenarioModelInput): Promise<CostScenarioModel>;
  updateScenarioModel?(modelId: string, input: CostScenarioModelInput): Promise<CostScenarioModel>;
  /**
   * Rejects while the model is referenced — the server answers 409 with the
   * referents, and the thrown error's message names them.
   */
  deleteScenarioModel?(modelId: string): Promise<void>;
  /** Everything referencing a model (budgets first — they page people). */
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
  /** A metric's reported days, newest first — the "is this being fed?" answer. */
  listBusinessMetricValues?(metricId: string, limit?: number): Promise<BusinessMetricValue[]>;
  /**
   * Report days by hand. Re-reporting a day restates it rather than adding to
   * it, the same guarantee the API and `infra.businessMetrics.write` give.
   */
  writeBusinessMetricValues?(
    metricId: string,
    values: BusinessMetricValueInput[],
  ): Promise<BusinessMetricWriteResult>;
}

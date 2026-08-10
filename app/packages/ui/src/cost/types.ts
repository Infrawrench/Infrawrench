import type {
  BudgetWithStatus,
  CostAccountStatus,
  CostAnomaly,
  CostAnomalySettings,
  CostAnomalySettingsView,
  CostDimensionOption,
  CreditBurndown,
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core";
import type { BudgetInput, CostQueryRequest, CostQueryResponse } from "./config.js";

/**
 * The cost contract lives in client-core so mobile (which doesn't depend on
 * this package) shares one definition of it; re-exported for web and desktop.
 */
export type {
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
}

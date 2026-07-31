import type {
  BudgetWithStatus,
  CostAccountStatus,
  CostAnomaly,
  CostDimensionOption,
} from "@infrawrench/client-core";
import type { BudgetInput, CostQueryRequest, CostQueryResponse } from "./config.js";

/**
 * The cost contract lives in client-core so mobile (which doesn't depend on
 * this package) shares one definition of it; re-exported for web and desktop.
 */
export type {
  CostAccountStatus,
  CostPollError,
  BudgetWithStatus,
  BudgetPlacement,
  /** A detected spend anomaly, as listed on the Costs panel. */
  CostAnomaly,
  CostAnomalyDimension,
  /** One selectable value in a dimension picker. */
  CostDimensionOption,
} from "@infrawrench/client-core";

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
  listDashboards(): Promise<CostsPanelDashboard[]>;
  createBudget?(input: BudgetInput): Promise<{ id: string }>;
  updateBudget?(budgetId: string, input: BudgetInput): Promise<void>;
  deleteBudget?(budgetId: string): Promise<void>;
  /** Add a budget card for `budgetId` to `dashboardId`. */
  addBudgetToDashboard?(dashboardId: string, budgetId: string, title: string): Promise<void>;
  /** Remove one budget card, identified by the widget id from `placements`. */
  removeBudgetPlacement?(widgetId: string): Promise<void>;
}

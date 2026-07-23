import type { CostQueryRequest, CostQueryResponse } from "./config.js";

/** One selectable value in a dimension picker. */
export interface CostDimensionOption {
  value: string;
  label: string;
}

/**
 * Host-injected data access for the cost components. Web wraps `apiFetch`;
 * desktop (cloud mode) wraps its cloud-api helpers — the components stay
 * platform-agnostic.
 */
export interface CostApi {
  queryCosts(req: CostQueryRequest): Promise<CostQueryResponse>;
  /** `dimension` also accepts "tag-keys" to list tag keys. */
  loadDimensionValues(dimension: string, tagKey?: string): Promise<CostDimensionOption[]>;
}

/** Budget list row as returned by GET /budgets (with current-month status). */
export interface BudgetWithStatus {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  filters: unknown[];
  thresholds: Array<{ type: "actual" | "forecast"; percent: number }>;
  month: string;
  actualCents: number;
  forecastCents: number | null;
  currentMonthEvents: Array<{
    id: string;
    thresholdType: "actual" | "forecast";
    thresholdPercent: number;
    triggeredAt: string;
  }>;
}

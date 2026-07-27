import type { CostAccountStatus } from "@infrawrench/client-core";
import type { CostQueryRequest, CostQueryResponse } from "./config.js";

/** One selectable value in a dimension picker. */
export interface CostDimensionOption {
  value: string;
  label: string;
}

/**
 * The cost contract lives in client-core so mobile (which doesn't depend on
 * this package) shares one definition of it; re-exported for web and desktop.
 */
export type { CostAccountStatus, CostPollError, BudgetWithStatus } from "@infrawrench/client-core";

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

/**
 * Cost-reporting contract.
 *
 * A plugin that can report actual (billed or billable) spend for an account
 * declares a `costs` capability on its manifest and implements
 * `PluginClient.fetchCostData`. The host owns scheduling (a low-frequency
 * background pass — provider billing APIs are rate-limited and sometimes
 * billed per request), storage, and rendering; the plugin owns everything
 * provider-specific: which billing API to call, pagination, and normalizing
 * the response into daily {@link CostRow}s.
 */

/** Declares that this plugin can report actual spend for an account. */
export interface CostCapabilityDeclaration {
  /**
   * Dimensions this provider can break costs down by. `provider` and
   * `account` always exist — the host derives them from the account row —
   * so only finer-grained dimensions are declared here. Omit `resource` for
   * providers where per-resource rows would explode cardinality.
   */
  dimensions: Array<"service" | "region" | "resource" | "tag">;
  /**
   * How many days of history `fetchCostData` can return. Bounds the host's
   * initial backfill. Defaults to 365.
   */
  maxHistoryDays?: number;
  /**
   * Providers restate recent costs after the fact (late-arriving usage,
   * credits). The host re-fetches this trailing window on every incremental
   * collection so restatements are absorbed. Defaults to 3.
   */
  restatementDays?: number;
  /**
   * True when amounts are period-native (invoice/billing-cycle totals dated
   * to period boundaries) rather than true daily costs. The host surfaces
   * this so daily-binned charts can label the series as monthly-native.
   */
  periodNative?: boolean;
}

/**
 * One normalized cost datum: the spend for a single day and dimension
 * combination. Plugins that only have coarser data (monthly invoices) date
 * rows to the period boundary and set `periodNative` on their declaration.
 */
export interface CostRow {
  /** Billing day, `YYYY-MM-DD`, UTC. */
  date: string;
  /** Provider service/product name (e.g. "AmazonEC2"), when declared. */
  service?: string;
  /** Provider region identifier, when declared. */
  region?: string;
  /** Provider-native resource identifier, when declared. */
  resourceId?: string;
  /** Provider/virtual tags attached to the spend, when declared. */
  tags?: Record<string, string>;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /**
   * Net cost for this day + dimension combination in `currency`. Plugins for
   * usage-priced providers convert units to money internally (the user should
   * never have to know the provider's meter model).
   */
  amount: number;
  /** Optional underlying consumption quantity backing `amount`. */
  usageAmount?: number;
  /** Unit for `usageAmount`, e.g. "GB-Hours". */
  usageUnit?: string;
}

/** Inclusive ISO-date range passed to `fetchCostData`. */
export interface CostFetchRange {
  /** First day to include, `YYYY-MM-DD` UTC. */
  fromDate: string;
  /** Last day to include, `YYYY-MM-DD` UTC. */
  toDate: string;
}

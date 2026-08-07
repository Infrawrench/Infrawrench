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

/**
 * A link the host renders next to a cost-collection failure. Same shape as
 * `CredentialField.helpLink` — opened through the host's external-URL handler
 * so it works in the browser, the desktop shell, and the mobile app.
 */
export interface CostHelpLink {
  label: string;
  url: string;
}

/**
 * Thrown by `fetchCostData` when collection can't proceed until the user
 * does something — the provider's billing export isn't enabled, a required
 * credential field is blank, the billing role is missing. The host stores the
 * message against the account and surfaces it wherever cost data is shown,
 * rather than silently retrying forever.
 *
 * Plugins should build `helpLink.url` from what they know about the account
 * (project id, subscription id, team slug) so the link lands on the page the
 * user has to act on rather than a generic docs index.
 */
export class CostSetupError extends Error {
  readonly helpLink: CostHelpLink | undefined;

  constructor(message: string, helpLink?: CostHelpLink) {
    super(message);
    this.name = "CostSetupError";
    this.helpLink = helpLink;
  }
}

/** Inclusive ISO-date range passed to `fetchCostData`. */
export interface CostFetchRange {
  /** First day to include, `YYYY-MM-DD` UTC. */
  fromDate: string;
  /** Last day to include, `YYYY-MM-DD` UTC. */
  toDate: string;
}

/**
 * Forward-looking cost estimation.
 *
 * `fetchCostData` above reports what a provider *has* billed. `estimateCost`
 * answers the other question — what a given configuration *would* cost per
 * month — from the same per-region rate data the plugin already fetches for
 * its size pickers. One implementation feeds every surface that asks the
 * question: the live figure in the create form, the "+$340/month" delta on an
 * edit, the standing estimate on a resource's detail page, and the projected
 * spend change in the weekly digest.
 *
 * Estimates are quotes, not invoices. A plugin that cannot price a
 * configuration returns `null` rather than a plausible number, and one that
 * can price only part of it prices that part and says so — see
 * {@link CostEstimate.partial}.
 */

/**
 * One priced component of a {@link CostEstimate}. Line items are what make an
 * estimate checkable: a single total invites "where did that come from", and
 * the answer has to be in the estimate rather than in the provider's
 * calculator.
 */
export interface CostEstimateLineItem {
  /** What is being charged, e.g. `"Compute (e2-standard-2)"` or `"Boot disk"`. */
  label: string;
  /** This component's monthly contribution, in the estimate's currency. */
  monthlyAmount: number;
  /**
   * How the figure was reached, in units the user already sees in the form:
   * `"730 h × $0.0335/h"`, `"50 GB × $0.10/GB-month"`, `"3 nodes × $24.82"`.
   * Never a bare rate the user would have to look up to interpret.
   */
  detail?: string;
  /** Consumption backing the amount, e.g. `50` with `unit: "GB"`. */
  quantity?: number;
  /** Unit for `quantity`, e.g. `"GB"`, `"nodes"`, `"vCPU"`. */
  unit?: string;
}

/**
 * A monthly cost estimate for one resource configuration.
 *
 * `monthlyAmount` is always the sum of `lineItems` — hosts render the total
 * and the breakdown from the same object, so the two cannot disagree. Build
 * one with {@link buildCostEstimate} rather than by hand and that stays true.
 */
export interface CostEstimate {
  /** Total monthly cost, the sum of `lineItems`, in `currency`. */
  monthlyAmount: number;
  /** ISO 4217 currency code. Providers that publish list prices in USD say `"USD"`. */
  currency: string;
  /** The components of `monthlyAmount`, largest first. Never empty. */
  lineItems: CostEstimateLineItem[];
  /**
   * True when a component of the resource is known to exist but could not be
   * priced — an unknown SKU, a rate the provider does not publish, a boot disk
   * whose size is not among the fields the caller passed. The total is then a
   * floor, and hosts label it as one. Omit it (rather than setting `false`)
   * when the estimate covers everything the plugin knows to charge for.
   */
  partial?: boolean;
  /**
   * Caveats worth showing under the breakdown — "excludes egress",
   * "on-demand rate; a reservation would be cheaper", "storage billed
   * separately". Short sentences, not paragraphs.
   */
  notes?: string[];
}

/** Round to whole cents. Estimates are quoted money, not floating-point residue. */
function toCents(amount: number): number {
  return Number(amount.toFixed(2));
}

/**
 * Assemble a {@link CostEstimate} from line items: drops components that
 * priced to nothing, rounds each to cents, sorts largest first, and derives
 * the total from what survived.
 *
 * Returns `null` when nothing could be priced — which is the signal hosts use
 * to show no estimate at all. That is deliberately different from an estimate
 * of `$0`: "we don't know" and "it's free" are different answers, and quoting
 * the second when you mean the first is the failure this whole capability
 * exists to avoid.
 */
export function buildCostEstimate(
  lineItems: Array<CostEstimateLineItem | null | undefined>,
  options?: { currency?: string; partial?: boolean; notes?: string[] },
): CostEstimate | null {
  const priced = lineItems
    .filter((item): item is CostEstimateLineItem => {
      if (!item) return false;
      return Number.isFinite(item.monthlyAmount) && item.monthlyAmount !== 0;
    })
    .map((item) => ({ ...item, monthlyAmount: toCents(item.monthlyAmount) }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  if (priced.length === 0) return null;
  return {
    monthlyAmount: toCents(priced.reduce((sum, item) => sum + item.monthlyAmount, 0)),
    currency: options?.currency ?? "USD",
    lineItems: priced,
    ...(options?.partial ? { partial: true } : {}),
    ...(options?.notes?.length ? { notes: options.notes } : {}),
  };
}

/**
 * The monthly difference between two estimates — what a host quotes as
 * "this change adds $340/month".
 *
 * Returns `null` when the comparison would be meaningless rather than zero:
 * either side unpriced (an unknown SKU on one end makes the delta unknown,
 * not nil) or the two in different currencies (there is no exchange rate here
 * to convert with, and inventing one would be worse than declining).
 */
export function costEstimateDelta(
  before: CostEstimate | null | undefined,
  after: CostEstimate | null | undefined,
): number | null {
  if (!before || !after) return null;
  if (before.currency !== after.currency) return null;
  return toCents(after.monthlyAmount - before.monthlyAmount);
}

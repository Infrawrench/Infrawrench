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
  /**
   * True when this provider's rows carry a meaningful {@link CostRow.chargeType}
   * — that is, the plugin can tell usage apart from a credit, a tax line, a
   * refund, or the purchase of a commitment.
   *
   * Declaring it false (the default) is not a claim that the provider only ever
   * bills usage; it is a claim that *this plugin cannot tell*, so every row it
   * writes is recorded as `usage`. The host uses the flag to decide whether
   * "Charge type" is worth offering as a breakdown for an org, rather than
   * showing a picker whose every value but one is permanently empty.
   */
  chargeTypes?: boolean;
  /**
   * True when this provider reports an amortized amount distinct from the cash
   * amount — the up-front fee of a reservation, savings plan, or committed-use
   * discount spread across the term it buys, rather than landed whole on the
   * day it was charged.
   *
   * Defaults to false, and false means {@link CostRow.amortizedAmount} is never
   * set, so amortized queries fall back to the cash amount for this provider.
   * The host gates the amortized view on at least one connected account
   * declaring this: without the flag the view would look like a second opinion
   * on the same numbers, when it is in fact the same numbers.
   */
  amortization?: boolean;
  /**
   * True when this plugin *derives* its amounts rather than reading billed
   * spend from the provider. Two shapes qualify: inventory × a rate card (the
   * provider has no billing API at all, so the only available number is "what
   * these resources list for"), and usage × published list prices (the provider
   * meters consumption but never prices it).
   *
   * Defaults to false, which means the amounts came from the provider's own
   * billing data and can be reconciled against an invoice line for line.
   *
   * Declaring it matters because an estimate is wrong in three specific,
   * one-directional ways, and a user who compares it to an invoice will find
   * the gap before they find the explanation:
   *
   * - It under-reports anything that existed for part of the period and was
   *   then deleted. Inventory is a snapshot of what is there now; a machine
   *   that ran for three weeks and was destroyed on the 22nd is simply not in
   *   it, and the three weeks it cost are missing from the total.
   * - It prices everything at list. Negotiated rates, volume tiers, committed
   *   spend and sustained-use discounts all make the real bill lower, and
   *   support plans, egress and add-ons make it higher.
   * - It cannot represent anything that is not a resource: credits, refunds,
   *   tax, and one-off charges have no inventory to hang off, so they never
   *   appear at all.
   *
   * The host surfaces this next to the collection notices wherever an
   * estimating account is in scope, so the number is labelled before it is
   * trusted.
   */
  estimated?: boolean;
}

/**
 * What a cost row *is*, as opposed to what it costs.
 *
 * Every provider bills more than consumption, and totalling those lines
 * together is how a month reads as flat while the underlying usage doubled: a
 * $60k reservation purchase and $60k of credits cancel out, a refund looks like
 * negative usage, tax inflates every service breakdown. Splitting the rows by
 * what kind of charge they are is what makes each of those visible.
 *
 * - `usage` — consumption billed at whatever rate applied. The default, and
 *   what every row without a charge type is.
 * - `commitment_fee` — buying a commitment: a reservation's up-front payment,
 *   a savings plan's recurring fee, a committed-use contract. Cash out the door
 *   on one day for capacity spanning months, which is exactly the row
 *   {@link CostRow.amortizedAmount} exists to re-date.
 * - `commitment_discount` — the (negative) line a provider writes when a
 *   commitment covers usage that would otherwise have been billed on demand.
 * - `credit` — promotional or negotiated credit applied against the bill.
 * - `tax` — VAT, sales tax, and the like, billed separately from the service.
 * - `refund` — money returned for a past charge.
 * - `adjustment` — a billing correction that is none of the above.
 * - `support` — a support plan or contract, usually priced off the rest of the
 *   bill rather than off any one service.
 * - `other` — the provider distinguishes a category this union does not. Better
 *   than silently filing it under `usage`, which would overstate consumption.
 */
export type CostChargeType =
  | "usage"
  | "commitment_fee"
  | "commitment_discount"
  | "credit"
  | "tax"
  | "refund"
  | "adjustment"
  | "support"
  | "other";

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
  /**
   * What kind of charge this row is. Absent means `"usage"` — every plugin
   * written before this field existed keeps reporting consumption, which is
   * what it was reporting.
   *
   * Set it whenever the provider tells you, and declare `chargeTypes: true` on
   * the manifest when you do. The failure it prevents is a reader who cannot
   * tell a month of real growth from a month with one commitment purchase in
   * it, and who therefore either panics at a spike that is prepayment or misses
   * growth that a credit is masking.
   */
  chargeType?: CostChargeType;
  /**
   * The same money spread across the period it actually covers, in `currency`,
   * when the provider distinguishes it. Absent means "same as `amount`".
   *
   * `amount` is cash: what the provider charged on `date`. For consumption the
   * two agree, and most rows should leave this unset rather than duplicating
   * the number. They diverge for commitments — a one-year reservation paid up
   * front is a single enormous `amount` on the purchase day and 1/365th of it
   * on each of the 365 days it buys. Only the second answers "what did this
   * service cost us in July".
   *
   * Zero is a meaningful value here and is not the same as absent: a day
   * covered by an already-paid commitment has a cash amount and an amortized
   * amount that legitimately differ, and a row whose cash already landed
   * elsewhere amortizes to nothing on this day. Readers that fall back to
   * `amount` must therefore treat only *absent* as "no opinion".
   */
  amortizedAmount?: number;
  /**
   * Provider-native id of the reservation, savings plan, or committed-use
   * discount this row is attributable to — the purchase itself, the discount it
   * produced, and the usage it covered all carry the same id.
   *
   * It is what makes a commitment auditable after the fact: without it the
   * up-front fee and the months of discount it bought are unrelated rows that
   * happen to be near each other, and nobody can answer whether a specific
   * reservation paid for itself.
   */
  commitmentId?: string;
}

/**
 * Commitment inventory.
 *
 * A commitment is capacity bought ahead of use: an AWS Reserved Instance or
 * Savings Plan, a GCP committed-use discount, an Azure reservation. They are
 * the largest single lever on a big cloud bill, and they are invisible in a
 * spend graph — the purchase is one spike, the discount is a slightly lower
 * slope, and whether the thing is paying for itself is a question no daily
 * total answers. This contract makes the holdings themselves first-class:
 * a plugin that can list them declares `commitments` on its manifest and
 * implements {@link PluginClient.fetchCommitments}; the host stores the
 * records and joins them against cost rows via {@link CostRow.commitmentId}.
 *
 * The cardinal rule of every field below: **omit, never substitute**. A
 * missing amount renders as "not reported"; a zero renders as "free"; and one
 * of those two ends up in a finance review. Providers differ wildly in what
 * they report (Azure's list API returns no purchase price at all, GCP's
 * returns no money of any kind), and inventing a number to fill the gap is
 * strictly worse than the gap.
 */

/**
 * What was bought.
 *
 * - `reservation` — capacity for a specific resource shape (EC2/RDS RIs,
 *   Azure reservations). Usually scoped to an instance family and often a
 *   region or zone.
 * - `savings_plan` — a spend commitment ("$X/hour of compute, whatever it
 *   runs on") rather than a capacity one. AWS Savings Plans.
 * - `committed_use` — GCP's contract form: committed *units* of resource
 *   (vCPUs, GB of memory) in a region for a term.
 */
export type CommitmentKind = "reservation" | "savings_plan" | "committed_use";

/**
 * Normalized lifecycle state. Providers each have a zoo of states
 * (payment-pending, retired, queued-deleted, Split, Merged, CANCELLED…);
 * three answers cover every question a reader actually asks.
 *
 * Normalization rules, chosen so mistakes understate rather than overstate
 * holdings:
 * - payment-failed / queued-deleted / cancelled → `expired` (the discount is
 *   not being applied, whatever the provider's word for it).
 * - pending-return → `active` (the provider is still applying the discount
 *   until the return settles).
 * - any state a plugin does not recognise → `expired`. A future provider
 *   state mapped to `active` would inflate the org's apparent coverage; the
 *   same state mapped to `expired` merely hides a commitment until the
 *   mapping is taught about it.
 */
export type CommitmentState = "active" | "expired" | "queued";

/**
 * How the commitment is paid for. `all_upfront` / `partial_upfront` /
 * `no_upfront` are the AWS trichotomy; `monthly` is Azure's billing-plan
 * form (the whole price in monthly installments — distinct from
 * `no_upfront`, which is pay-per-use-hour at the discounted rate).
 */
export type CommitmentPaymentOption = "all_upfront" | "partial_upfront" | "no_upfront" | "monthly";

/**
 * One committed unit quantity for a unit-denominated commitment (GCP CUDs):
 * `{ unit: "VCPU", amount: 32 }`, `{ unit: "MEMORY_GB", amount: 128 }`.
 * The unit string is provider-native and passed through untranslated — the
 * reader is going to compare it against the provider's console.
 */
export interface CommitmentUnitAmount {
  unit: string;
  amount: number;
}

/**
 * One provider-reported utilization aggregate — Azure is the only provider
 * that returns its own utilization on the list response, at 1/7/30-day
 * grains. Passed through verbatim and **never blended with anything the host
 * derives**: the provider's number is computed against the provider's own
 * meter, ours against ingested cost rows, and averaging the two produces a
 * figure that is checkable against neither.
 */
export interface CommitmentProviderUtilization {
  /** Trailing window the aggregate covers, in days (1, 7, 30). */
  grainDays: number;
  /** Utilization percentage over that window, 0–100, as the provider reports it. */
  percentage: number;
}

/**
 * One commitment, as the provider reports it.
 *
 * Field register — every field, what it means, and why it is optional when
 * it is:
 *
 * - `id` — provider-native identifier, and the join key against
 *   {@link CostRow.commitmentId}. Use whatever the billing data carries:
 *   EC2's `DescribeReservedInstances` returns no ARN, so the bare
 *   reservation id is the key there; RDS RIs and Savings Plans have ARNs in
 *   the billing data, so prefer those. Must be stable across fetches —
 *   it is the upsert identity.
 * - `kind` — see {@link CommitmentKind}.
 * - `description` — human-readable summary ("2× m5.xlarge Linux/UNIX",
 *   "Compute Savings Plan", the reservation's display name). Never empty;
 *   this is the row label.
 * - `scope` — provider scope qualifier when one exists: an AZ for a
 *   zonal RI, "Shared"/"Single" for an Azure applied-scope, an EC2 instance
 *   family for an EC2 Instance Savings Plan. Omit when the provider has no
 *   such concept for this record.
 * - `region` — provider region the commitment applies to. **Absent is a real
 *   state, not missing data**: an AWS Compute Savings Plan or a
 *   regionally-unscoped reservation applies across regions, and stamping a
 *   region on it would wrongly narrow it. Renderers say "All regions".
 * - `startDate` / `endDate` — ISO-8601 timestamps of the term. `endDate` may
 *   be *derived* as start + provider-reported duration when the provider
 *   reports no end of its own (RDS RIs) — that is exact arithmetic on
 *   provider data, not a substitution. Omit it only when neither an end nor
 *   a duration is reported.
 * - `termDays` — the purchased term length **as the provider reports it**
 *   (from `duration`/`termDurationInSeconds`/`plan`/`term`), never derived
 *   from `endDate - startDate`: a split or merged commitment (Azure does
 *   this on exchange) keeps its original term but gets fresh dates, and the
 *   date difference no longer spans the term. Deriving dates from the term
 *   is fine; deriving the term from dates is the bug.
 * - `paymentOption` — see {@link CommitmentPaymentOption}. Omit when the
 *   provider does not report one.
 * - `currency` — ISO 4217 code for every money field on this record. Omit
 *   when the record carries no money at all (GCP, Azure list responses).
 * - `upfrontAmount` — what was paid up front for the whole holding, in
 *   `currency`. Per-record total: providers that quote per-instance prices
 *   (EC2 RIs) must multiply by the instance count before reporting. Omit
 *   when unknown — never 0 unless the provider says 0.
 * - `recurringAmount` / `recurringPeriod` — the recurring charge and the
 *   period it recurs on. The pair is atomic: an amount without a period is
 *   a 730× ambiguity (hourly vs monthly), so a plugin that cannot state the
 *   period omits both. This is why AWS Savings Plans'
 *   `recurringPaymentAmount` is deliberately not mapped — its period is
 *   documented nowhere.
 * - `hourlyCommitmentAmount` — for spend commitments: the committed spend
 *   per hour in `currency` (a Savings Plan's `commitment`). This is the
 *   number utilization is measured against.
 * - `unitCommitments` — for unit-denominated commitments: the committed
 *   quantities. **`hourlyCommitmentAmount` XOR `unitCommitments` is the
 *   load-bearing split**: a record with the former supports "did we spend
 *   the committed dollars" (answerable from cost rows); a record with only
 *   the latter supports "are we using the committed vCPUs", which cost rows
 *   cannot answer — and the host must say "unknown" there, not 0%.
 * - `state` — see {@link CommitmentState}.
 * - `providerUtilization` — see {@link CommitmentProviderUtilization}.
 */
export interface CommitmentRecord {
  id: string;
  kind: CommitmentKind;
  description: string;
  scope?: string;
  region?: string;
  /** ISO-8601 timestamp. */
  startDate: string;
  /** ISO-8601 timestamp. Omitted when the provider reports no end. */
  endDate?: string;
  termDays?: number;
  paymentOption?: CommitmentPaymentOption;
  currency?: string;
  upfrontAmount?: number;
  recurringAmount?: number;
  recurringPeriod?: "hour" | "month";
  hourlyCommitmentAmount?: number;
  unitCommitments?: CommitmentUnitAmount[];
  state: CommitmentState;
  providerUtilization?: CommitmentProviderUtilization[];
}

/**
 * Declares that this plugin can list purchased commitments for an account
 * via `fetchCommitments`. `kinds` names what the provider sells — it drives
 * the empty-state copy and the docs, not any fetch behaviour.
 */
export interface CommitmentsCapabilityDeclaration {
  kinds: CommitmentKind[];
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

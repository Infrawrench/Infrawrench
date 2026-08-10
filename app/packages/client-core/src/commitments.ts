/**
 * Commitments — reserved instances, savings plans, committed-use discounts —
 * as the `GET /commitments` feed reports them (permission `costs:read`).
 *
 * Wire contract shared by web, desktop, the CLI and mobile. The types mirror
 * `server-core/src/commitments/feed.ts`, and the doc comments repeat the
 * parts a renderer must not get wrong:
 *
 * - Null money fields mean "the provider did not report a price" (Azure's
 *   list API reports none, GCP's reports no money at all). Render "not
 *   reported" — never $0, which reads as "free".
 * - Null `region` means "applies across regions" (an AWS Compute Savings
 *   Plan). Render "All regions", not a blank.
 * - Null `utilization.utilization` means "not measurable", with the reason
 *   attached. Never render it as 0% — in a table, "unknown" and "unused"
 *   look identical, and one of them gets a commitment cancelled.
 * - Coverage is a range. `broadRatio` (lower bound) and `narrowRatio`
 *   (upper bound) bracket the truth; showing either alone overstates
 *   certainty.
 * - Planner savings honour `savingBasis`: "up to $X" for `upper_bound`,
 *   "$X–$Y" for `range`. The published discounts are marketing ceilings.
 */
import type { CloudFetch } from "./fetch";

export type CommitmentKind = "reservation" | "savings_plan" | "committed_use";
export type CommitmentState = "active" | "expired" | "queued";
export type CommitmentPaymentOption = "all_upfront" | "partial_upfront" | "no_upfront" | "monthly";

export type CommitmentUtilizationReason =
  "unit_denominated" | "no_active_days" | "no_data_days" | "unattributed_rows";

export interface CommitmentUtilizationView {
  /** delivered ÷ obligation, unclamped. **Null means not measurable, never 0.** */
  utilization: number | null;
  reason?: CommitmentUtilizationReason;
  obligationAmount: number | null;
  deliveredAmount: number;
  activeDays: number;
  /** Active days with cost data — the only days counted in the obligation. */
  measuredDays: number;
  /** Active days without cost data, reported rather than counted as idle. */
  missingDays: number;
  windowDays: number;
}

export interface CommitmentHolding {
  accountId: string;
  accountName: string;
  pluginId: string;
  commitmentId: string;
  kind: CommitmentKind;
  description: string;
  scope: string | null;
  /** Null = applies across regions. Render "All regions". */
  region: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Provider-reported term; never derived from the dates. */
  termDays: number | null;
  paymentOption: CommitmentPaymentOption | null;
  /** Null when the record carries no money at all. */
  currency: string | null;
  /** Null = not reported. Never render as $0. */
  upfrontAmount: number | null;
  recurringAmount: number | null;
  recurringPeriod: "hour" | "month" | null;
  hourlyCommitmentAmount: number | null;
  unitCommitments: Array<{ unit: string; amount: number }> | null;
  state: CommitmentState;
  /** Azure's own utilization aggregates, verbatim; never blended with ours. */
  providerUtilization: Array<{ grainDays: number; percentage: number }> | null;
  lastSeenAt: string;
  utilization: CommitmentUtilizationView;
}

export interface CommitmentCoverageCurrency {
  currency: string;
  coveredAmount: number;
  uncoveredAmount: number;
  uncoveredEligibleAmount: number;
  /** Lower bound: covered ÷ (covered + all uncovered usage). */
  broadRatio: number | null;
  /** Upper bound: covered ÷ (covered + uncovered usage in eligible cells). */
  narrowRatio: number | null;
}

export interface CommitmentCoverageView {
  /** False = every in-scope account excluded — unavailable, not 0%. */
  available: boolean;
  currencies: CommitmentCoverageCurrency[];
  excludedAccountIds: string[];
}

export type CommitmentPlannerGate = "presence" | "not_in_decline" | "floor" | "materiality";

export interface CommitmentRecommendationView {
  pluginId: string;
  service: string;
  region: string;
  currency: string;
  recommendedDailyCommitment: number;
  recommendedHourlyCommitment: number;
  annualCommitment: number;
  p50DailySpend: number;
  /** "range" → "$X–$Y"; "upper_bound" → "up to $Y". Never a bare "$Y". */
  savingBasis: "range" | "upper_bound";
  discountRateMin?: number;
  discountRateMax: number;
  estimatedAnnualSavingMin?: number;
  estimatedAnnualSavingMax: number;
  /** 1 − discount: the workload can shrink by the discount before losing. */
  breakEvenUtilization: number;
  annualLossIfUsageHalves: number;
}

export interface CommitmentPlannerView {
  /** False when the data window is under the 60-day minimum. */
  available: boolean;
  windowDayCount: number;
  recommendations: CommitmentRecommendationView[];
  rejected: Array<{
    pluginId: string;
    service: string;
    region: string;
    currency: string;
    gate: CommitmentPlannerGate;
  }>;
}

export interface CommitmentPollFailureView {
  accountId: string;
  accountName: string;
  pluginId: string;
  message: string;
  failureCount: number;
}

export interface CommitmentsFeed {
  holdings: CommitmentHolding[];
  coverage: CommitmentCoverageView;
  planner: CommitmentPlannerView;
  failures: CommitmentPollFailureView[];
  /** Commitment-capable accounts never yet collected — named, not omitted. */
  pendingAccountIds: string[];
  utilizationWindowDays: number;
  plannerWindowDays: number;
}

/**
 * The org's commitments, coverage, utilization and recommendations
 * (`GET /commitments`, permission `costs:read`).
 */
export async function fetchCommitments(
  api: CloudFetch,
  orgId: string,
): Promise<CommitmentsFeed | null> {
  return api.org<CommitmentsFeed>(orgId, "/commitments");
}

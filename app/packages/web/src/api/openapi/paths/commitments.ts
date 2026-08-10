import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerCommitmentPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const CommitmentUnitAmount = strict({
    unit: z
      .string()
      .describe('Provider-native unit label, untranslated — "VCPU", "MEMORY_MB", "LOCAL_SSD_GB".'),
    amount: z.number(),
  }).openapi("CommitmentUnitAmount");

  const CommitmentProviderUtilization = strict({
    grainDays: z.number().int().describe("Trailing window the aggregate covers (1, 7, 30)."),
    percentage: z
      .number()
      .describe("Utilization percentage 0–100, exactly as the provider reports it."),
  }).openapi("CommitmentProviderUtilization");

  const CommitmentUtilization = strict({
    utilization: z
      .number()
      .nullable()
      .describe(
        "delivered ÷ obligation, unclamped (values above 1 mean spend past the commitment). " +
          "**Null means not measurable** — never 0, which would read as 'unused'; the reason " +
          "field says why.",
      ),
    reason: z
      .enum(["unit_denominated", "no_active_days", "no_data_days", "unattributed_rows"])
      .optional()
      .describe(
        "Why utilization is null: `unit_denominated` — the commitment is in resource units " +
          "(GCP CUDs) and cost rows cannot say how many ran; `no_active_days` — the term does " +
          "not intersect the window; `no_data_days` — no cost data was collected on any active " +
          "day; `unattributed_rows` — the account's plugin does not stamp commitment ids onto " +
          "cost rows, so delivered spend would falsely read as zero.",
      ),
    obligationAmount: z
      .number()
      .nullable()
      .describe("hourlyCommitmentAmount × 24 × measuredDays, in the commitment's currency."),
    deliveredAmount: z.number(),
    activeDays: z.number().int().describe("Days of the window the commitment was active."),
    measuredDays: z
      .number()
      .int()
      .describe(
        "Active days with cost data — the only days in the obligation. Counting a day the " +
          "collection never ran would make a fully-used plan read as under-utilized.",
      ),
    missingDays: z
      .number()
      .int()
      .describe("Active days without cost data, reported rather than silently counted."),
    windowDays: z.number().int(),
  }).openapi("CommitmentUtilization");

  const CommitmentHolding = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    commitmentId: z
      .string()
      .describe(
        "Provider-native id — the join key against cost rows' commitment dimension (an ARN " +
          "where billing data carries ARNs, the bare id where it does not).",
      ),
    kind: z.enum(["reservation", "savings_plan", "committed_use"]),
    description: z.string(),
    scope: z
      .string()
      .nullable()
      .describe("Provider scope qualifier — an AZ, an instance family, 'Shared'."),
    region: z
      .string()
      .nullable()
      .describe(
        "Null means the commitment applies across regions (an AWS Compute Savings Plan) — a " +
          "real state, rendered as 'All regions', not missing data.",
      ),
    startDate: IsoDateTime.nullable(),
    endDate: IsoDateTime.nullable(),
    termDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "Provider-reported term length — never derived from the dates, which stop spanning " +
          "the term once a commitment is split or merged.",
      ),
    paymentOption: z.enum(["all_upfront", "partial_upfront", "no_upfront", "monthly"]).nullable(),
    currency: z
      .string()
      .nullable()
      .describe("Null when the provider reports no money at all for this record."),
    upfrontAmount: z
      .number()
      .nullable()
      .describe(
        "Null means the provider did not report a price (Azure's list API reports none) — " +
          "'not reported', never rendered as 'free'.",
      ),
    recurringAmount: z.number().nullable(),
    recurringPeriod: z
      .enum(["hour", "month"])
      .nullable()
      .describe("Atomic with recurringAmount: an amount without a period is a 730× ambiguity."),
    hourlyCommitmentAmount: z
      .number()
      .nullable()
      .describe("Committed spend per hour — what utilization is measured against."),
    unitCommitments: z
      .array(CommitmentUnitAmount)
      .nullable()
      .describe(
        "Committed resource quantities for unit-denominated commitments (GCP CUDs). A record " +
          "has either this or hourlyCommitmentAmount — the split decides which utilization " +
          "question is even askable.",
      ),
    state: z.enum(["active", "expired", "queued"]),
    providerUtilization: z
      .array(CommitmentProviderUtilization)
      .nullable()
      .describe(
        "The provider's own utilization aggregates (Azure reservations only), verbatim — " +
          "never blended with the derived utilization below.",
      ),
    lastSeenAt: IsoDateTime,
    utilization: CommitmentUtilization,
  }).openapi("CommitmentHolding");

  const CommitmentCoverageCurrency = strict({
    currency: z.string(),
    coveredAmount: z.number().describe("Usage spend on rows stamped with a commitment id."),
    uncoveredAmount: z.number(),
    uncoveredEligibleAmount: z
      .number()
      .describe(
        "Uncovered usage in cells where a commitment landed in the window — provider evidence " +
          "of committability, not a hand-maintained service table.",
      ),
    broadRatio: z
      .number()
      .nullable()
      .describe("Lower bound: covered ÷ (covered + all uncovered usage)."),
    narrowRatio: z
      .number()
      .nullable()
      .describe("Upper bound: covered ÷ (covered + uncovered usage in eligible cells)."),
  }).openapi("CommitmentCoverageCurrency");

  const CommitmentCoverage = strict({
    available: z
      .boolean()
      .describe(
        "False when every in-scope account was excluded — 'we cannot tell' reported as " +
          "unavailable, never as 0%.",
      ),
    currencies: z.array(CommitmentCoverageCurrency),
    excludedAccountIds: z
      .array(Uuid)
      .describe(
        "Accounts whose plugin cannot tell usage from other charge types; their rows would " +
          "drag coverage down for reasons unrelated to purchasing.",
      ),
  }).openapi("CommitmentCoverage");

  const CommitmentRecommendation = strict({
    pluginId: enums.PluginId,
    service: z.string(),
    region: z.string(),
    currency: z.string(),
    recommendedDailyCommitment: z
      .number()
      .describe("p10 of daily uncovered usage spend, nearest-rank — the floor, not the average."),
    recommendedHourlyCommitment: z.number(),
    annualCommitment: z.number(),
    p50DailySpend: z.number(),
    savingBasis: z
      .enum(["range", "upper_bound"])
      .describe(
        'Published discounts are "up to" figures. `range` renders "$X–$Y"; `upper_bound` ' +
          'renders "up to $Y" — never a bare "$Y".',
      ),
    discountRateMin: z.number().optional(),
    discountRateMax: z.number(),
    estimatedAnnualSavingMin: z.number().optional(),
    estimatedAnnualSavingMax: z.number(),
    breakEvenUtilization: z
      .number()
      .describe(
        "1 − discount: below this utilization the commitment loses to on-demand. " +
          "Equivalently, the workload can shrink by the discount before committing was a mistake.",
      ),
    annualLossIfUsageHalves: z
      .number()
      .describe(
        "max(0, annualCommitment × (0.5 − discount)) at the shallow end of the published " +
          "discount — a ceiling on regret where no floor rate is published.",
      ),
  }).openapi("CommitmentRecommendation");

  const CommitmentRejectedCell = strict({
    pluginId: enums.PluginId,
    service: z.string(),
    region: z.string(),
    currency: z.string(),
    gate: z
      .enum(["presence", "not_in_decline", "floor", "materiality"])
      .describe("First gate the cell failed, in evaluation order — the most actionable objection."),
  }).openapi("CommitmentRejectedCell");

  const CommitmentPlanner = strict({
    available: z.boolean().describe("False when the data window is under the 60-day minimum."),
    windowDayCount: z.number().int(),
    recommendations: z.array(CommitmentRecommendation),
    rejected: z.array(CommitmentRejectedCell),
  }).openapi("CommitmentPlanner");

  const CommitmentPollFailure = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    message: z.string(),
    failureCount: z.number().int(),
  }).openapi("CommitmentPollFailure");

  const CommitmentsFeed = strict({
    holdings: z.array(CommitmentHolding),
    coverage: CommitmentCoverage,
    planner: CommitmentPlanner,
    failures: z.array(CommitmentPollFailure),
    pendingAccountIds: z
      .array(Uuid)
      .describe("Commitment-capable accounts never yet collected — named rather than omitted."),
    utilizationWindowDays: z.number().int(),
    plannerWindowDays: z.number().int(),
  }).openapi("CommitmentsFeed");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/commitments",
    tags: ["Commitments"],
    summary: "Reservations, savings plans and committed-use discounts",
    description:
      "The organization's purchased commitments — reserved instances, savings plans, " +
      "committed-use discounts — with three derived readings.\n\n" +
      "**Coverage** is a range, not a number: the broad ratio counts every uncovered usage " +
      "dollar in the denominator (a lower bound — egress and per-request charges can never be " +
      "committed against), the narrow ratio only uncovered usage in cells where a commitment " +
      "demonstrably landed (an upper bound). Accounts whose plugin cannot distinguish charge " +
      "types are excluded and listed; a scope where every account is excluded reports " +
      "unavailable, not 0%.\n\n" +
      "**Utilization** is measured only over days cost data was actually collected — a " +
      "collection gap is reported as missing days, never counted as idle commitment. " +
      "Unit-denominated commitments (GCP) report null with a reason, never 0%. Azure's own " +
      "reported utilization rides on each holding separately and is never blended with the " +
      "derived figure.\n\n" +
      "**The planner** recommends committing at the p10 floor of daily uncovered spend, gated " +
      "on presence, trend, floor and materiality. Savings are quoted against published " +
      '"up to" discount rates and marked as such. Nothing is ever purchased automatically.',
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's commitments, coverage, utilization and recommendations",
        content: { "application/json": { schema: CommitmentsFeed } },
      },
    },
  });
}

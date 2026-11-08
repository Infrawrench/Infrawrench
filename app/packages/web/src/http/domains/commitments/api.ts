/**
 * Commitments: `/api/org/:orgId/commitments`, the endpoint definitions.
 *
 * Reserved instances, savings plans and committed-use discounts: the holdings,
 * coverage of usage spend (as a range; there is no single honest
 * denominator), derived utilization, and the savings planner's
 * recommendations. Read-only, deliberately: this API describes and
 * recommends, it never purchases. `costs:read`, because a commitment is spend
 * information.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { PluginId } from "../../schemas/plugin-registry";

const CommitmentUnitAmount = Schema.Struct({
  unit: Schema.String.annotate({
    description: 'Provider-native unit label, untranslated, "VCPU", "MEMORY_MB", "LOCAL_SSD_GB".',
  }),
  amount: Schema.Finite,
}).annotate({ identifier: "CommitmentUnitAmount" });

const CommitmentProviderUtilization = Schema.Struct({
  grainDays: Schema.Int.annotate({
    description: "Trailing window the aggregate covers (1, 7, 30).",
  }),
  percentage: Schema.Finite.annotate({
    description: "Utilization percentage 0–100, exactly as the provider reports it.",
  }),
}).annotate({ identifier: "CommitmentProviderUtilization" });

const CommitmentUtilization = Schema.Struct({
  utilization: Schema.NullOr(Schema.Finite).annotate({
    description:
      "delivered ÷ obligation, unclamped (values above 1 mean spend past the commitment). " +
      "**Null means not measurable**; never 0, which would read as 'unused'; the reason " +
      "field says why.",
  }),
  reason: Schema.optionalKey(
    Schema.Literals([
      "unit_denominated",
      "no_active_days",
      "no_data_days",
      "unattributed_rows",
    ]).annotate({
      description:
        "Why utilization is null: `unit_denominated`: the commitment is in resource units " +
        "(GCP CUDs) and cost rows cannot say how many ran; `no_active_days`: the term does " +
        "not intersect the window; `no_data_days`: no cost data was collected on any active " +
        "day; `unattributed_rows`: the account's plugin does not stamp commitment ids onto " +
        "cost rows, so delivered spend would falsely read as zero.",
    }),
  ),
  obligationAmount: Schema.NullOr(Schema.Finite).annotate({
    description: "hourlyCommitmentAmount × 24 × measuredDays, in the commitment's currency.",
  }),
  deliveredAmount: Schema.Finite,
  activeDays: Schema.Int.annotate({ description: "Days of the window the commitment was active." }),
  measuredDays: Schema.Int.annotate({
    description:
      "Active days with cost data; the only days in the obligation. Counting a day the " +
      "collection never ran would make a fully-used plan read as under-utilized.",
  }),
  missingDays: Schema.Int.annotate({
    description: "Active days without cost data, reported rather than silently counted.",
  }),
  windowDays: Schema.Int,
}).annotate({ identifier: "CommitmentUtilization" });

const CommitmentHolding = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  commitmentId: Schema.String.annotate({
    description:
      "Provider-native id: the join key against cost rows' commitment dimension (an ARN " +
      "where billing data carries ARNs, the bare id where it does not).",
  }),
  kind: Schema.Literals(["reservation", "savings_plan", "committed_use"]),
  description: Schema.String,
  scope: Schema.NullOr(Schema.String).annotate({
    description: "Provider scope qualifier; an AZ, an instance family, 'Shared'.",
  }),
  region: Schema.NullOr(Schema.String).annotate({
    description:
      "Null means the commitment applies across regions (an AWS Compute Savings Plan); a " +
      "real state, rendered as 'All regions', not missing data.",
  }),
  startDate: Schema.NullOr(IsoDateTime),
  endDate: Schema.NullOr(IsoDateTime),
  termDays: Schema.NullOr(Schema.Int).annotate({
    description:
      "Provider-reported term length; never derived from the dates, which stop spanning " +
      "the term once a commitment is split or merged.",
  }),
  paymentOption: Schema.NullOr(
    Schema.Literals(["all_upfront", "partial_upfront", "no_upfront", "monthly"]),
  ),
  currency: Schema.NullOr(Schema.String).annotate({
    description: "Null when the provider reports no money at all for this record.",
  }),
  upfrontAmount: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Null means the provider did not report a price (Azure's list API reports none); " +
      "'not reported', never rendered as 'free'.",
  }),
  recurringAmount: Schema.NullOr(Schema.Finite),
  recurringPeriod: Schema.NullOr(Schema.Literals(["hour", "month"])).annotate({
    description: "Atomic with recurringAmount: an amount without a period is a 730× ambiguity.",
  }),
  hourlyCommitmentAmount: Schema.NullOr(Schema.Finite).annotate({
    description: "Committed spend per hour; what utilization is measured against.",
  }),
  unitCommitments: Schema.NullOr(Schema.Array(CommitmentUnitAmount)).annotate({
    description:
      "Committed resource quantities for unit-denominated commitments (GCP CUDs). A record " +
      "has either this or hourlyCommitmentAmount; the split decides which utilization " +
      "question is even askable.",
  }),
  state: Schema.Literals(["active", "expired", "queued"]),
  providerUtilization: Schema.NullOr(Schema.Array(CommitmentProviderUtilization)).annotate({
    description:
      "The provider's own utilization aggregates (Azure reservations only), verbatim; " +
      "never blended with the derived utilization below.",
  }),
  lastSeenAt: IsoDateTime,
  utilization: CommitmentUtilization,
}).annotate({ identifier: "CommitmentHolding" });

const CommitmentCoverageCurrency = Schema.Struct({
  currency: Schema.String,
  coveredAmount: Schema.Finite.annotate({
    description: "Usage spend on rows stamped with a commitment id.",
  }),
  uncoveredAmount: Schema.Finite,
  uncoveredEligibleAmount: Schema.Finite.annotate({
    description:
      "Uncovered usage in cells where a commitment landed in the window; provider evidence " +
      "of committability, not a hand-maintained service table.",
  }),
  broadRatio: Schema.NullOr(Schema.Finite).annotate({
    description: "Lower bound: covered ÷ (covered + all uncovered usage).",
  }),
  narrowRatio: Schema.NullOr(Schema.Finite).annotate({
    description: "Upper bound: covered ÷ (covered + uncovered usage in eligible cells).",
  }),
}).annotate({ identifier: "CommitmentCoverageCurrency" });

const CommitmentCoverage = Schema.Struct({
  available: Schema.Boolean.annotate({
    description:
      "False when every in-scope account was excluded; 'we cannot tell' reported as " +
      "unavailable, never as 0%.",
  }),
  currencies: Schema.Array(CommitmentCoverageCurrency),
  excludedAccountIds: Schema.Array(Uuid).annotate({
    description:
      "Accounts whose plugin cannot tell usage from other charge types; their rows would " +
      "drag coverage down for reasons unrelated to purchasing.",
  }),
}).annotate({ identifier: "CommitmentCoverage" });

const CommitmentRecommendation = Schema.Struct({
  pluginId: PluginId,
  service: Schema.String,
  region: Schema.String,
  currency: Schema.String,
  recommendedDailyCommitment: Schema.Finite.annotate({
    description: "p10 of daily uncovered usage spend, nearest-rank; the floor, not the average.",
  }),
  recommendedHourlyCommitment: Schema.Finite,
  annualCommitment: Schema.Finite,
  p50DailySpend: Schema.Finite,
  savingBasis: Schema.Literals(["range", "upper_bound"]).annotate({
    description:
      'Published discounts are "up to" figures. `range` renders "$X–$Y"; `upper_bound` ' +
      'renders "up to $Y"; never a bare "$Y".',
  }),
  discountRateMin: Schema.optionalKey(Schema.Finite),
  discountRateMax: Schema.Finite,
  estimatedAnnualSavingMin: Schema.optionalKey(Schema.Finite),
  estimatedAnnualSavingMax: Schema.Finite,
  breakEvenUtilization: Schema.Finite.annotate({
    description:
      "1 − discount: below this utilization the commitment loses to on-demand. " +
      "Equivalently, the workload can shrink by the discount before committing was a mistake.",
  }),
  annualLossIfUsageHalves: Schema.Finite.annotate({
    description:
      "max(0, annualCommitment × (0.5 − discount)) at the shallow end of the published " +
      "discount: a ceiling on regret where no floor rate is published.",
  }),
}).annotate({ identifier: "CommitmentRecommendation" });

const CommitmentRejectedCell = Schema.Struct({
  pluginId: PluginId,
  service: Schema.String,
  region: Schema.String,
  currency: Schema.String,
  gate: Schema.Literals(["presence", "not_in_decline", "floor", "materiality"]).annotate({
    description: "First gate the cell failed, in evaluation order; the most actionable objection.",
  }),
}).annotate({ identifier: "CommitmentRejectedCell" });

const CommitmentPlanner = Schema.Struct({
  available: Schema.Boolean.annotate({
    description: "False when the data window is under the 60-day minimum.",
  }),
  windowDayCount: Schema.Int,
  recommendations: Schema.Array(CommitmentRecommendation),
  rejected: Schema.Array(CommitmentRejectedCell),
}).annotate({ identifier: "CommitmentPlanner" });

const CommitmentPollFailure = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  message: Schema.String,
  failureCount: Schema.Int,
}).annotate({ identifier: "CommitmentPollFailure" });

export const CommitmentsFeed = Schema.Struct({
  holdings: Schema.Array(CommitmentHolding),
  coverage: CommitmentCoverage,
  planner: CommitmentPlanner,
  failures: Schema.Array(CommitmentPollFailure),
  pendingAccountIds: Schema.Array(Uuid).annotate({
    description: "Commitment-capable accounts never yet collected, named rather than omitted.",
  }),
  utilizationWindowDays: Schema.Int,
  plannerWindowDays: Schema.Int,
}).annotate({ identifier: "CommitmentsFeed" });

export class CommitmentsGroup extends HttpApiGroup.make("commitments")
  .add(
    HttpApiEndpoint.get("feed", "/", {
      params: OrgParams,
      success: CommitmentsFeed,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Reservations, savings plans and committed-use discounts")
      .annotate(
        OpenApi.Description,
        "The organization's purchased commitments (reserved instances, savings plans, " +
          "committed-use discounts) with three derived readings.\n\n" +
          "**Coverage** is a range, not a number: the broad ratio counts every uncovered usage " +
          "dollar in the denominator (a lower bound; egress and per-request charges can never be " +
          "committed against), the narrow ratio only uncovered usage in cells where a commitment " +
          "demonstrably landed (an upper bound). Accounts whose plugin cannot distinguish charge " +
          "types are excluded and listed; a scope where every account is excluded reports " +
          "unavailable, not 0%.\n\n" +
          "**Utilization** is measured only over days cost data was actually collected; a " +
          "collection gap is reported as missing days, never counted as idle commitment. " +
          "Unit-denominated commitments (GCP) report null with a reason, never 0%. Azure's own " +
          "reported utilization rides on each holding separately and is never blended with the " +
          "derived figure.\n\n" +
          "**The planner** recommends committing at the p10 floor of daily uncovered spend, gated " +
          "on presence, trend, floor and materiality. Savings are quoted against published " +
          '"up to" discount rates and marked as such. Nothing is ever purchased automatically.',
      )
      .annotate(
        SuccessDescription,
        "The organization's commitments, coverage, utilization and recommendations",
      ),
  )
  .prefix("/api/org/:orgId/commitments")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Commitments") {}

export class CommitmentsApi extends withApiDefaults(
  HttpApi.make("commitments").add(CommitmentsGroup),
) {}

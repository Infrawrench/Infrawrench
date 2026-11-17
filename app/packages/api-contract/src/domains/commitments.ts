/**
 * Commitments: `/api/org/:orgId/commitments`, the endpoint definitions.
 *
 * Reserved instances, savings plans and committed-use discounts: the holdings,
 * coverage of usage spend (as a range; there is no single honest
 * denominator), derived utilization, and the savings planner's
 * recommendations. The holdings side is read-only, deliberately: this API
 * describes and recommends, it never purchases. `costs:read`, because a
 * commitment is spend information.
 *
 * Saved commitment reports are the second group under the same mount
 * (`/reports`, `/report-query`, `/report-options`): coverage, utilization,
 * savings and commitment cost over time. Reading is `costs:read`; saving,
 * replacing and deleting one is a cost-object edit, `costs:write`, as for cost
 * reports. Request bodies are the shared schemas
 * (`@infrawrench/api-contract/schemas`), decoded strictly.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  COMMITMENT_REPORT_NOTICES,
  COMMITMENT_REPORT_PROVIDER_STATUSES,
} from "@infrawrench/client-core";
import {
  CommitmentReportConfig,
  CommitmentReportGranularity,
  CommitmentReportGroupBy,
  CommitmentReportInput,
  CommitmentReportKind,
  STRICT_PARSE_OPTIONS,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";

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

/* ---------------------------------------------------- saved reports -- */

/** Strict, as the hand-written normalizer was: an unknown key is refused, not dropped. */
const strictBody = { ...STRICT_PARSE_OPTIONS, errors: "all" } as const;

export const CommitmentReport = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  config: CommitmentReportConfig,
  folderId: Schema.NullOr(Uuid),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CommitmentReport" });

const CommitmentReportTotals = Schema.Struct({
  covered: Schema.Finite.annotate({
    description: "Amortized usage the selected commitments covered: the used commitment cost.",
  }),
  coveredAll: Schema.Finite.annotate({ description: "Amortized usage any commitment covered." }),
  unused: Schema.Finite.annotate({
    description:
      "Amortized commitment fees no usage absorbed (only fee rows with a reported amortized " +
      "amount).",
  }),
  uncovered: Schema.Finite.annotate({
    description: "Amortized usage no commitment covered: the on-demand remainder.",
  }),
  uncoveredEligible: Schema.Finite.annotate({
    description:
      "Uncovered usage in (provider, service, region) cells with any covered usage in the window.",
  }),
  coveredOnDemand: Schema.Finite.annotate({
    description:
      "On-demand equivalent of covered usage, summed over rows whose provider reported one.",
  }),
  coveredMeasured: Schema.Finite.annotate({ description: "Amortized amount of those same rows." }),
}).annotate({ identifier: "CommitmentReportTotals" });

const ratio = (description: string) =>
  Schema.NullOr(Schema.Finite).annotate({
    description: `${description} Null when the denominator is zero, never 0.`,
  });

const CommitmentReportMetricValues = Schema.Struct({
  coverage: ratio(
    "covered ÷ (coveredAll + uncovered), or the bucket's usage under a commitment grouping.",
  ),
  eligibleCoverage: ratio(
    "covered ÷ (coveredAll + uncoveredEligible): the upper bound of coverage.",
  ),
  utilization: ratio("covered ÷ (covered + unused)."),
  effectiveSavingsRate: ratio(
    "netSavings ÷ (onDemandEquivalent + uncovered). Null also when netSavings is null.",
  ),
  netSavings: Schema.NullOr(Schema.Finite).annotate({
    description:
      "(coveredOnDemand − coveredMeasured) − unused. Null when there was covered usage and none " +
      "of it had a reported on-demand equivalent; covered usage without one counts as saving " +
      "nothing.",
  }),
  onDemandRemainder: Schema.Finite.annotate({ description: "uncovered." }),
  commitmentCost: Schema.Finite.annotate({ description: "covered + unused." }),
  usedCommitmentCost: Schema.Finite.annotate({ description: "covered." }),
  unusedCommitmentCost: Schema.Finite.annotate({ description: "unused." }),
  onDemandEquivalent: Schema.Finite.annotate({
    description: "coveredOnDemand + (covered − coveredMeasured).",
  }),
  savingsMeasuredShare: Schema.NullOr(Schema.Finite).annotate({
    description:
      "coveredMeasured ÷ covered: how much of the covered spend the savings figure measured. " +
      "Null without covered spend.",
  }),
}).annotate({ identifier: "CommitmentReportMetricValues" });

const CommitmentReportPoint = Schema.Struct({
  bucket: Schema.String.annotate({ description: "The bucket's first day, `YYYY-MM-DD`." }),
  totals: CommitmentReportTotals,
  metrics: CommitmentReportMetricValues,
}).annotate({ identifier: "CommitmentReportPoint" });

const CommitmentReportSeries = Schema.Struct({
  id: Schema.String.annotate({
    description: "Group key and currency, joined by U+0000: unique within a result.",
  }),
  groupKey: Schema.String.annotate({
    description:
      "The group's key: empty without grouping; a sentinel (`__on_demand__`, " +
      "`__unattributed__`, `__unknown_kind__`) or the value otherwise.",
  }),
  label: Schema.String.annotate({
    description:
      "An account's name, a provider's display name or a holding's description where the " +
      "server can name the key; the key itself otherwise (clients name kinds and sentinels).",
  }),
  currency: Schema.String,
  points: Schema.Array(CommitmentReportPoint),
  total: Schema.Struct({ totals: CommitmentReportTotals, metrics: CommitmentReportMetricValues }),
}).annotate({ identifier: "CommitmentReportSeries" });

const CommitmentReportProviderStatus = Schema.Literals(
  COMMITMENT_REPORT_PROVIDER_STATUSES,
).annotate({
  description:
    "`inventory_only`: the provider's holdings are collected but its cost rows do not " +
    "distinguish covered usage (GCP today), so it is left out of every metric rather than " +
    "read as 0% covered.",
});

const CommitmentReportProvider = Schema.Struct({
  pluginId: PluginId,
  displayName: Schema.String,
  status: CommitmentReportProviderStatus,
  accountCount: Schema.Int,
}).annotate({ identifier: "CommitmentReportProvider" });

const CommitmentReportNotice = Schema.Literals(COMMITMENT_REPORT_NOTICES).annotate({
  identifier: "CommitmentReportNotice",
  description:
    "`unused_lumped_monthly`: a provider in scope books a month's unused commitment fee on one " +
    "day of its daily data, so a daily or weekly utilization dips on that day. " +
    "`unattributed_commitment_usage`: some covered usage could not be tied to a commitment and " +
    "is grouped as `__unattributed__`. `partial_savings_measurement`: some covered usage had no " +
    "reported on-demand equivalent and counts as saving nothing. `no_measurable_accounts`: no " +
    "account in scope can measure coverage.",
});

const resultFields = {
  from: Schema.String.annotate({ description: "First day of the resolved window." }),
  to: Schema.String.annotate({
    description: "Last day of the resolved window; never past today.",
  }),
  granularity: CommitmentReportGranularity,
  groupBy: CommitmentReportGroupBy,
  buckets: Schema.Array(Schema.String).annotate({
    description: "Every bucket start in the window, gaps included, ascending.",
  }),
  series: Schema.Array(CommitmentReportSeries).annotate({
    description: "One per group and currency, largest commitment cost first.",
  }),
  overall: Schema.Array(CommitmentReportSeries).annotate({
    description: "All groups combined, one series per currency.",
  }),
  providers: Schema.Array(CommitmentReportProvider),
  notices: Schema.Array(CommitmentReportNotice),
};

export const CommitmentReportResult = Schema.Struct(resultFields).annotate({
  identifier: "CommitmentReportResult",
});

export const CommitmentReportRunResult = Schema.Struct({
  ...resultFields,
  reportId: Uuid,
  name: Schema.String,
}).annotate({ identifier: "CommitmentReportRunResult" });

export const CommitmentReportOptions = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      pluginId: PluginId,
      displayName: Schema.String,
      status: CommitmentReportProviderStatus,
    }),
  ),
  accounts: Schema.Array(Schema.Struct({ id: Uuid, name: Schema.String, pluginId: PluginId })),
  services: Schema.Array(Schema.String),
  regions: Schema.Array(Schema.String),
  commitments: Schema.Array(
    Schema.Struct({
      commitmentId: Schema.String,
      accountId: Uuid,
      pluginId: PluginId,
      kind: CommitmentReportKind,
      description: Schema.String,
      state: Schema.String,
    }),
  ),
}).annotate({ identifier: "CommitmentReportOptions" });

export class CommitmentReportsGroup extends HttpApiGroup.make("commitmentReports")
  .add(
    HttpApiEndpoint.get("reportOptions", "/report-options", {
      params: OrgParams,
      success: CommitmentReportOptions,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Picker values for the commitment report editor")
      .annotate(
        OpenApi.Description,
        "Providers (with whether their cost rows can measure coverage), accounts, the services " +
          "and regions with usage in the last 180 days, and the commitment inventory. Scoped to " +
          "what the caller may see.",
      )
      .annotate(SuccessDescription, "Options"),
    // A read despite the method, like `/costs/query`.
    HttpApiEndpoint.post("reportQuery", "/report-query", {
      params: OrgParams,
      payload: CommitmentReportConfig,
      success: CommitmentReportResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(InvalidRequestMessage, "Invalid commitment report config")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Run an unsaved commitment report config")
      .annotate(
        OpenApi.Description,
        "Coverage, utilization, savings and commitment cost over time, on the amortized basis. " +
          "See `CommitmentReportMetricValues` for each metric's formula. A read despite the method.",
      )
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.get("listReports", "/reports", {
      params: OrgParams,
      success: Schema.Array(CommitmentReport),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List saved commitment reports")
      .annotate(
        OpenApi.Description,
        "The saved commitment reports the caller's sharing lets them open, by name.",
      )
      .annotate(SuccessDescription, "Reports"),
    HttpApiEndpoint.post("createReport", "/reports", {
      params: OrgParams,
      payload: CommitmentReportInput,
      success: CommitmentReport,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid commitment report")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Create a commitment report")
      .annotate(
        OpenApi.Description,
        "Stored exactly as sent. The creator is the report's implicit owner for sharing; filing " +
          "it in a folder needs editor access to the folder. Audit-logged.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("getReport", "/reports/:id", {
      params: OrgIdParams,
      success: CommitmentReport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a commitment report")
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.put("updateReport", "/reports/:id", {
      params: OrgIdParams,
      payload: CommitmentReportInput,
      success: CommitmentReport,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid commitment report")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Replace a commitment report")
      .annotate(
        OpenApi.Description,
        "Name, description, config and folder together. Needs editor. Moving it to another " +
          "folder needs editor access to that folder. Audit-logged.",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteReport", "/reports/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a commitment report")
      .annotate(OpenApi.Description, "Soft delete; its sharing goes with it. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
    // A read despite the method.
    HttpApiEndpoint.post("runReport", "/reports/:id/run", {
      params: OrgIdParams,
      success: CommitmentReportRunResult,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run a saved commitment report")
      .annotate(
        OpenApi.Description,
        "A relative date range resolves against today on every run, and a range reaching past " +
          "today ends today.",
      )
      .annotate(SuccessDescription, "The report"),
  )
  .prefix("/api/org/:orgId/commitments")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Commitments") {}

export class CommitmentsApi extends withApiDefaults(
  HttpApi.make("commitments").add(CommitmentsGroup).add(CommitmentReportsGroup),
) {}

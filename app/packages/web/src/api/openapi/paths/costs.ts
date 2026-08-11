import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
// One definition of the shape that keeps the collected figure visible — see
// `paths/billing-rules.ts`.
import { CostAdjustmentSummary } from "./billing-rules";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const CostDimension = z
  .enum([
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ])
  .openapi("CostDimension");

const CostChargeType = z
  .enum([
    "usage",
    "commitment_covered_usage",
    "commitment_fee",
    "commitment_discount",
    "credit",
    "tax",
    "refund",
    "adjustment",
    "support",
    "other",
  ])
  .openapi("CostChargeType");

const CostBasis = z
  .enum(["cash", "amortized"])
  .describe(
    "Which number to sum. `cash` is what the provider charged on the day it charged it — the " +
      "default, and what every query returned before this existed. `amortized` spreads a " +
      "commitment's up-front fee across the term it buys, so a year of capacity bought on one " +
      "day is counted on the days it covers. Providers that report no amortized amount fall " +
      "back to their cash amount, so an amortized query over a mixed estate never drops their " +
      "spend.",
  )
  .openapi("CostBasis");

const CostFilter = strict({
  dimension: CostDimension,
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("CostFilter");

const CostQueryRequest = strict({
  from: IsoDate,
  to: IsoDate,
  binning: z.enum(["daily", "weekly", "monthly", "cumulative"]),
  groupBy: z.enum([
    "none",
    "provider",
    "account",
    "service",
    "region",
    "resource",
    "tag",
    "charge_type",
    "commitment",
  ]),
  groupByTagKey: z.string().optional(),
  filters: z.array(CostFilter).optional(),
  query: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "The same filter written as text, in the cost query language — an alternative to " +
        "`filters`, compiled server-side into exactly that structure.\n\n" +
        "Grammar: a conjunction of equality terms joined by `AND`. A term is " +
        "`dimension = 'value'`, `dimension != 'value'`, `dimension IN ('a','b')` or " +
        "`dimension NOT IN ('a','b')`; the tag dimension takes its key in brackets, " +
        "`tag['owner'] = 'platform'`. Keywords are case-insensitive, strings may be single- or " +
        "double-quoted, and a quote inside a value is escaped by doubling it (`'it''s'`) or " +
        "with a backslash (`'it\\'s'`).\n\n" +
        "`OR` is deliberately not supported: the stored filter is a conjunction, so several " +
        "values of one dimension go in an `IN` list and unrelated alternatives need separate " +
        "queries. Anything the structured filter cannot express is a parse error rather than a " +
        "second execution path.\n\n" +
        "Sending both `query` and a non-empty `filters` is a 400, not a precedence rule. A " +
        "parse failure is a 400 whose body carries `queryError` with the character `offset`, " +
        "the `length` of the offending span, and the `expected` alternatives there.",
    )
    .openapi({ example: "provider = 'aws' AND tag['env'] != 'dev'" }),
  savedFilterId: z
    .string()
    .optional()
    .describe(
      "A saved cost filter (see /saved-cost-filters) applied by reference. Resolved " +
        "server-side at query time and AND-composed with whichever of `filters`/`query` is " +
        "present — unlike those two it is a composition, not an alternative. An id that does " +
        "not resolve to a live filter is a 400; the query is never silently run unfiltered.",
    ),
  topN: z.number().int().min(1).max(15).optional(),
  comparePreviousPeriod: z.boolean().optional(),
  forecast: z.boolean().optional(),
  scenarioModelId: z
    .string()
    .optional()
    .describe(
      "Apply a scenario model (see /cost-scenarios) to the projection: known future cost the " +
        "trend cannot see. Requires `forecast: true` — sending it without one is a 400, not a " +
        "no-op, because a caller who asked for assumptions and silently got none back is the " +
        "failure this feature exists to prevent. The adjusted projection comes back as " +
        "`scenario`, **alongside** the untouched `forecast`, never instead of it. An id that " +
        "does not resolve is a 400.",
    ),
  costBasis: CostBasis.optional(),
  chargeTypes: z
    .array(CostChargeType)
    .optional()
    .describe(
      "Restrict to these kinds of charge. Omitted is all of them, which is what makes an " +
        "unfiltered total net rather than gross — credits, refunds and commitment discounts are " +
        "included. Rows collected before charge types existed, and rows from providers that " +
        "cannot distinguish them, are `usage`.",
    ),
  adjusted: z
    .boolean()
    .optional()
    .describe(
      "Apply the organization's billing rules (see /billing-rules) — markups, discounts, " +
        "reallocations. Omitted (the default, and what every unattended reader sends) is raw " +
        "collected spend. Present, the response carries `adjustment` with the collected totals " +
        "beside the adjusted ones and the rules that moved them; it is set even for an " +
        "organization with no rules, because the absence of that field is the only signal that " +
        "a figure is unadjusted.",
    ),
}).openapi("CostQueryRequest");

const CostSeriesPoint = strict({
  bucket: IsoDate,
  amount: z.number(),
}).openapi("CostSeriesPoint");

const CostQuerySeries = strict({
  key: z.string(),
  label: z.string(),
  currency: z.string(),
  points: z.array(CostSeriesPoint),
}).openapi("CostQuerySeries");

/**
 * Exported so `paths/cost-reports.ts` can describe `POST /cost-reports/:id/run`
 * with the same component rather than registering a second copy under a
 * near-identical name — running a report returns exactly a cost query result.
 */
const CostScenarioResult = strict({
  modelId: Uuid,
  modelName: z.string(),
  currency: z.string(),
  points: z
    .array(CostSeriesPoint)
    .describe(
      "The adjusted projection — exactly the same days as `forecast`, never one more or fewer. " +
        "A scenario modifies the projected region; it does not extend it, and it can never " +
        "touch a day that already has recorded spend behind it.",
    ),
  contributions: z
    .array(
      strict({
        adjustmentId: z.string(),
        label: z.string(),
        kind: z.enum(["one_off", "recurring", "rate_change"]),
        amount: z.number(),
      }),
    )
    .describe("Signed total each adjustment added across the horizon, in model order."),
  totalDelta: z.number().describe("Signed difference from the baseline across the horizon."),
  convertedFrom: z
    .string()
    .optional()
    .describe("Set when the model's amounts were converted at the org's stated rates."),
  outOfScope: z
    .array(z.string())
    .describe(
      "Adjustments this chart's own filters exclude, by label — a GCP commitment on an " +
        "AWS-filtered chart is correctly left out, and saying so is what makes the number " +
        "trustworthy rather than quietly assumed broken.",
    ),
}).openapi("CostScenarioResult");

export const CostQueryResponse = strict({
  series: z.array(CostQuerySeries),
  comparison: z.array(CostQuerySeries).optional(),
  forecast: z
    .array(CostSeriesPoint)
    .optional()
    .describe(
      "The **unadjusted trend** projection. Stays the trend even when a scenario is applied, " +
        "so a reader can always see what the fit said before anybody's assumptions touched it.",
    ),
  scenario: CostScenarioResult.optional(),
  currencies: z.array(z.string()),
  totals: z
    .record(z.number())
    .describe(
      "Period total per currency, and always exactly the sum of `series`. Fixed-amount " +
        "billing-rule charges are deliberately **not** folded in here — they have no series " +
        "behind them and are reported in `adjustment.fixedTotals` instead.",
    ),
  previousTotals: z.record(z.number()).optional(),
  adjustment: CostAdjustmentSummary.optional(),
}).openapi("CostQueryResponse");

const CostDimensionValues = strict({
  values: z.array(z.union([z.string(), strict({ value: z.string(), label: z.string() })])),
}).openapi("CostDimensionValues");

const CostAccountStatus = strict({
  accountId: Uuid,
  pluginId: z.string(),
  displayName: z.string(),
  supportsCosts: z.boolean(),
  periodNative: z.boolean(),
  dimensions: z.array(z.enum(["service", "region", "resource", "tag"])),
  chargeTypes: z
    .boolean()
    .describe(
      "Whether this account's plugin can tell one kind of charge from another. False means " +
        "every row it writes is recorded as `usage` — not that the provider only bills usage.",
    ),
  amortization: z
    .boolean()
    .describe(
      "Whether this account's plugin reports an amortized amount distinct from the cash " +
        "amount. Clients offer the amortized cost basis only when at least one account says " +
        "yes; elsewhere the amortized view is the cash numbers under another name.",
    ),
  estimated: z
    .boolean()
    .describe(
      "Whether this account's amounts are derived by Infrawrench — inventory priced against a " +
        "rate card, or metered usage priced at published list rates — rather than reported as " +
        "billed spend. True means the series cannot be reconciled against an invoice: resources " +
        "deleted part-way through a period are no longer in inventory to be priced, all rates " +
        "are list rather than negotiated, and credits, tax and refunds never appear.",
    ),
  costLastPolledAt: IsoDateTime.nullable(),
  costBackfilledAt: IsoDateTime.nullable(),
  costPollFailureCount: z.number().int(),
  costPollError: strict({
    message: z.string(),
    helpLink: strict({ label: z.string(), url: z.string() }).nullable(),
  })
    .nullable()
    .describe(
      "Last cost-collection failure for this account, cleared on the next success. " +
        "`helpLink` points at the provider page that fixes a setup problem when the " +
        "plugin can identify one (e.g. GCP's billing export console).",
    ),
  coverage: strict({ firstDay: IsoDate, lastDay: IsoDate }).nullable(),
}).openapi("CostAccountStatus");

const CostAnomaly = strict({
  id: Uuid,
  day: IsoDate.describe("The anomalous UTC day."),
  kind: z
    .enum(["spike", "new_source"])
    .describe(
      "Which detection produced the row. `spike` is spend far above the key's own trailing " +
        "baseline; `new_source` is a provider or service with no spend at all across the " +
        "trailing window that suddenly has material spend — it can never be a `spike`, since " +
        "a zero baseline has no mean or deviation to exceed. Rows written before new-source " +
        "detection existed read as `spike`.",
    ),
  dimension: z.enum(["provider", "service"]),
  dimensionKey: z.string().describe("The dimension's value — a plugin id or a service name."),
  currency: z.string(),
  actualCents: z.number().int(),
  baselineCents: z
    .number()
    .int()
    .describe(
      "Mean daily spend over the trailing 28-day baseline, in cents. Zero, or near it, for a " +
        "`new_source` — clients must not compute a percentage change from it.",
    ),
  thresholdCents: z
    .number()
    .int()
    .describe(
      "The detection bar the day cleared, in cents: baseline mean + N·stddev for a `spike`, " +
        "the new-source floor for a `new_source`.",
    ),
  detectedAt: IsoDateTime,
  notifiedAt: IsoDateTime.nullable().describe(
    "When the anomaly was delivered to a notification channel; null when delivery " +
      "failed or a recent anomaly for the same key suppressed it.",
  ),
  hints: z
    .array(z.string())
    .describe(
      "Root-cause hints computed when the anomaly fired: human-readable facts from the " +
        "change timeline and audit log for the anomalous day and the day before (e.g. " +
        '"12 gce-instance resources appeared", a workflow run, a lifted change freeze), ' +
        "ranked by likely relevance and capped at three. Empty when nothing notable " +
        "happened in the window or the anomaly predates hint collection.",
    ),
  acknowledgement: strict({
    explanation: z
      .string()
      .describe("What somebody established this finding was. Also the annotation's text."),
    acknowledgedAt: IsoDateTime.describe(
      "When the current explanation was recorded — restamped by a correction.",
    ),
    acknowledgedByUserId: z.string().nullable(),
    annotationId: Uuid.nullable().describe(
      "The cost annotation this created, drawn on every chart covering the anomalous day. " +
        "Null once that note has been deleted — which removes the marker, never the " +
        "acknowledgement: the finding stays explained.",
    ),
  })
    .nullable()
    .describe(
      "Present once somebody has explained this finding, null while it is still an open " +
        "question. Acknowledging does not suppress detection — the same key spiking again " +
        "on a later day is a new anomaly and fires as normal.",
    ),
}).openapi("CostAnomaly");

const CostAnomalySettings = strict({
  sigmas: z
    .number()
    .min(1)
    .max(10)
    .describe(
      "Standard deviations above a key's own trailing mean that count as a spike. " +
        "Lower is more sensitive. Bounded at 1 — below that roughly a third of ordinary " +
        "days clear the bar — and at 10, above which nothing short of a 10x jump fires. " +
        "Defaults to 3.",
    ),
  minDeltaCents: z
    .number()
    .int()
    .min(100)
    .max(10_000_000)
    .describe(
      "Minimum rise over the baseline mean before a spike alerts, in USD cents (converted " +
        "per series, so it means the same real amount in every currency). Defaults to 1000 ($10).",
    ),
  newSourceMinCents: z
    .number()
    .int()
    .min(100)
    .max(10_000_000)
    .describe(
      "Minimum first-day spend before a new spend source alerts, in USD cents. A key with no " +
        "prior spend has no statistical bar to clear, so this absolute floor is the only thing " +
        "keeping a new $0.02/day service quiet. Defaults to 2500 ($25).",
    ),
  smsAlerts: z
    .enum(["off", "new_source", "all"])
    .describe(
      "Which anomalies also text the organization's Twilio recipients. Defaults to `off` — " +
        "an organization with Twilio configured for budgets does not start receiving anomaly " +
        "texts until it asks to. `new_source` texts only about spend appearing from nothing, " +
        "which is what a leaked key looks like on a bill; `all` adds spikes on existing lines. " +
        "Delivery is batched — one SMS per detection pass summarizing what it alerted on, at " +
        "most one every six hours per organization — and never places a voice call. Push, " +
        "Slack and Teams delivery is unaffected by this setting.",
    ),
}).openapi("CostAnomalySettings");

/**
 * What the settings routes answer with: the stored object plus one derived
 * fact, so a client can tell "SMS is on" from "SMS is on and would actually
 * reach somebody" without holding `org:settings:write`.
 */
const CostAnomalySettingsView = CostAnomalySettings.extend({
  smsConfigured: z
    .boolean()
    .describe(
      "Whether an SMS raised right now could be delivered: paging enabled for the " +
        "organization, Twilio credentials and a from-number stored, and at least one recipient " +
        "opted into SMS. Read-only and derived — it is not accepted on PUT.",
    ),
}).openapi("CostAnomalySettingsView");

/**
 * Tuning for the three efficiency detectors. One object rather than three,
 * because an organization tunes them as one decision and the settings row is
 * one row — see `org_cost_efficiency_settings`.
 */
const CostEfficiencySettings = strict({
  commitmentExpiryEnabled: z
    .boolean()
    .describe("Whether commitments approaching their term end raise alerts. Defaults to true."),
  commitmentExpiryHorizonDays: z
    .array(z.number().int().min(1).max(730))
    .min(1)
    .max(6)
    .describe(
      "Days of notice, each firing at most once per commitment per term end. Defaults to " +
        "[60, 30, 7]. A commitment fires at the *smallest* horizon it has reached, so an " +
        "account connected 30 days before a term ends gets one alert, not two.",
    ),
  commitmentExpiryAlertOnExpired: z
    .boolean()
    .describe(
      "Whether a commitment that lapsed without any horizon warning having fired raises one " +
        "alert anyway. Defaults to true, and bounded to terms that ended within the last 90 " +
        "days — connecting an account with years of dead reservations produces one pass of " +
        "recent news, not an archive.",
    ),
  commitmentIdleEnabled: z
    .boolean()
    .describe("Whether under-used commitments raise alerts. Defaults to true."),
  commitmentIdleThresholdPercent: z
    .number()
    .int()
    .min(1)
    .max(99)
    .describe(
      "Utilization percent the whole window must stay under. Defaults to 70 — roughly where " +
        "a 1-year no-upfront commitment stops beating on-demand for the usage it covers.",
    ),
  commitmentIdleWindowDays: z
    .number()
    .int()
    .min(7)
    .max(90)
    .describe(
      "Trailing days utilization is aggregated over. Defaults to 30. Aggregated, never " +
        "sampled per day: a weekday-only workload reads about 71% over a month and does not " +
        "fire, which is the point.",
    ),
  commitmentIdleMinMeasuredDays: z
    .number()
    .int()
    .min(3)
    .max(90)
    .describe(
      "Window days that must carry cost data before anything is judged. Defaults to 14. A " +
        "commitment whose utilization cannot be measured at all — a unit-denominated GCP CUD, " +
        "or an account whose plugin reports no commitment attribution — never alerts, " +
        "regardless of this value.",
    ),
  commitmentIdleMinWasteCents: z
    .number()
    .int()
    .min(100)
    .max(100_000_000)
    .describe(
      "Least wasted money (obligation − delivered) before alerting, in USD cents, restated " +
        "per currency. Defaults to 5000 ($50).",
    ),
  unitCostRegressionEnabled: z
    .boolean()
    .describe("Whether rising cost per business-metric unit raises alerts. Defaults to true."),
  unitCostThresholdPercent: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("Percent the unit cost must rise versus the prior window. Defaults to 20."),
  unitCostWindowDays: z
    .number()
    .int()
    .min(7)
    .max(90)
    .describe(
      "Length of each of the two compared windows. Defaults to 14 — two whole weekly cycles " +
        "a side, so a weekday-shaped unit cost compares like with like.",
    ),
  unitCostMinReportedDays: z
    .number()
    .int()
    .min(5)
    .max(90)
    .describe(
      "Days inside **each** window that must carry a reported, positive metric value. " +
        "Defaults to 10. A day with no reported value is a gap and contributes to neither the " +
        "numerator nor the denominator; a window that fails this bar produces no comparison at " +
        "all rather than a comparison against a gap.",
    ),
  unitCostMinSpendCents: z
    .number()
    .int()
    .min(100)
    .max(100_000_000)
    .describe(
      "Least spend in the current window before alerting, in USD cents, restated per " +
        "currency. Defaults to 10000 ($100).",
    ),
}).openapi("CostEfficiencySettings");

const EfficiencyAlertEvent = strict({
  id: Uuid,
  kind: z
    .enum(["commitment_expiry", "commitment_idle", "unit_cost_regression"])
    .describe("Which detector produced it."),
  subject: z.string().describe("The commitment's description, or the business metric's name."),
  accountId: Uuid.nullable().describe("The account, for commitment kinds; null otherwise."),
  accountName: z.string().nullable(),
  currency: z.string().nullable().describe("ISO 4217 of `amount`, or null when it carries none."),
  amount: z
    .number()
    .nullable()
    .describe(
      "The money at stake, in **units of `currency`** rather than cents — commitment amounts " +
        "are provider-reported in currency units. Per kind: the monthly on-demand exposure for " +
        "an expiry, the wasted amount for an idle commitment, the current window's spend for a " +
        "regression.",
    ),
  detail: z
    .record(z.union([z.string(), z.number(), z.null()]))
    .describe("Per-kind display facts. Free-form; nothing branches on it."),
  firedAt: IsoDateTime,
  notifiedAt: IsoDateTime.nullable().describe(
    "When the alert reached its routed destinations, or null when nothing was routed (or the " +
      "routing rule held it for quiet hours and the follow-up pass has not run yet).",
  ),
}).openapi("EfficiencyAlertEvent");

const PushedCostRow = strict({
  date: IsoDate.describe("UTC day the spend belongs to."),
  currency: z.string().length(3).openapi({ example: "USD" }),
  amount: z.number().describe("Money for this day/dimension combination. Negative for credits."),
  service: z
    .string()
    .max(256)
    .optional()
    .openapi({ example: "Snowflake Compute", description: "Becomes a group/filter value." }),
  region: z.string().max(256).optional(),
  resourceId: z
    .string()
    .max(256)
    .optional()
    .describe("Opaque id of the thing being billed; groups the `resource` dimension."),
  tags: z
    .record(z.string())
    .optional()
    .describe(
      "Cost-allocation tags, at most 32. Keys starting with `infrawrench:` are reserved and rejected.",
    ),
  usageAmount: z.number().optional(),
  usageUnit: z.string().max(256).optional(),
  accountId: Uuid.optional().describe(
    "Attribute this row to a connected account. Must belong to the calling organization. " +
      "Omit to attribute it to the source itself.",
  ),
}).openapi("PushedCostRow");

const CostPushRequest = strict({
  source: z
    .string()
    .max(64)
    .openapi({
      example: "snowflake-invoices",
      description:
        "Stable slug naming the system that owns these rows: letters, digits, `.`, `_` and `-`. " +
        "It groups the rows under an `External` provider and an `external:<source>` account, " +
        "and re-pushing the same source over the same days restates only its own rows.",
    }),
  rows: z.array(PushedCostRow).max(5000),
}).openapi("CostPushRequest");

const CostPushResponse = strict({
  written: z.number().int(),
}).openapi("CostPushResponse");

export function registerCostPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/rows",
    tags: ["Costs"],
    summary: "Push cost rows from your own systems",
    description:
      "Reports spend Infrawrench has no provider plugin for — a parsed SaaS invoice, an internal " +
      "chargeback, a colo bill — into the same store the provider collectors write to, so it " +
      "appears in cost graphs, dimension filters, and budgets alongside everything else.\n\n" +
      "Rows are grouped under a caller-chosen `source`. Writes are idempotent per " +
      "`(source, day, service, region, resourceId, tags, currency)`: pushing the same day again " +
      "restates that day rather than adding to it, so a nightly job can safely re-push a trailing " +
      "window. Rows pushed under a source can never overwrite rows a provider collector wrote.\n\n" +
      "The whole batch is validated before anything is stored, so a 400 means nothing was written.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostPushRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Rows written",
        content: { "application/json": { schema: CostPushResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/query",
    tags: ["Costs"],
    summary: "Query aggregated cost series",
    description:
      "Aggregates collected provider spend into per-bucket, per-group series for cost graphs. " +
      "Currencies are never merged; mixed-currency orgs get one series per currency. " +
      "Optionally returns a previous-period comparison and a trend forecast.\n\n" +
      "`costBasis` chooses between cash and amortized money, and `chargeTypes` narrows which " +
      "kinds of charge count. Both the comparison period and the forecast are computed on the " +
      "same basis and charge types as the series itself.\n\n" +
      "The filter can be sent structurally as `filters` or as text in the cost query language " +
      "via `query` (`provider = 'aws' AND tag['env'] != 'dev'`). They are two spellings of one " +
      "filter: sending both is a 400, and a query that does not parse is a 400 carrying the " +
      "offset of the mistake.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostQueryRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Cost series",
        content: { "application/json": { schema: CostQueryResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/dimensions",
    tags: ["Costs"],
    summary: "List distinct values for a cost dimension",
    description:
      "Feeds the filter and group-by pickers. Pass dimension=tag-keys for tag keys; " +
      "dimension=tag requires tagKey. `charge_type` answers from the fixed set of charge " +
      "types rather than from the stored data, so the picker is populated before any " +
      "provider has reported one.",
    request: {
      params: OrgIdParam,
      query: strict({
        dimension: z.enum([
          "provider",
          "account",
          "service",
          "region",
          "resource",
          "tag",
          "charge_type",
          "commitment",
          "tag-keys",
        ]),
        tagKey: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Values",
        content: { "application/json": { schema: CostDimensionValues } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomalies",
    tags: ["Costs"],
    summary: "List recently detected cost anomalies",
    description:
      "Spend anomalies detected by the daily background pass. Two kinds share the list: a " +
      "`spike`, where a provider's or service's spend exceeded its trailing 28-day baseline " +
      "by a statistical threshold (mean + N·stddev, with an absolute floor to ignore " +
      "penny-scale noise), and a `new_source`, where a provider or service with no spend at " +
      "all across that window suddenly billed a material amount. Thresholds are per " +
      "organization — see GET /costs/anomaly-settings. Newest day first, capped at 200 rows.",
    request: {
      params: OrgIdParam,
      query: strict({
        days: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Window in days over anomalous days, 1-90. Defaults to 30."),
      }),
    },
    responses: {
      200: {
        description: "Anomalies",
        content: {
          "application/json": { schema: strict({ anomalies: z.array(CostAnomaly) }) },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/anomalies/{anomalyId}/acknowledge",
    tags: ["Costs"],
    summary: "Explain a detected cost anomaly",
    description:
      "Record what a finding actually was, and publish that sentence as a cost annotation on " +
      "**every** chart covering the anomalous day — the point being that 'we migrated the " +
      "fleet' is not a fact about whichever report somebody happened to open. The note's date " +
      "(the anomalous day) and its org-wide scope are derived from the anomaly and are not the " +
      "caller's to choose.\n\n" +
      "The reply is the updated anomaly, carrying `acknowledgement` with the id of the note it " +
      "created. Sending it again replaces the sentence and rewords that note rather than " +
      "filing a second one; it will not recreate a note that has since been deleted, since " +
      "deleting a note is a deliberate act and the finding stays explained without it.\n\n" +
      "This does not suppress detection. If the same provider or service spikes again on a " +
      "later day, that is a new anomaly and it is detected and alerted on as normal.",
    request: {
      params: OrgIdParam.extend({ anomalyId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: strict({
              explanation: z
                .string()
                .min(1)
                .max(500)
                .describe(
                  "One sentence on what caused the spend. Becomes the annotation's text, so " +
                    "the annotation's 500-character ceiling applies.",
                ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The acknowledged anomaly",
        content: { "application/json": { schema: CostAnomaly } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-settings",
    tags: ["Costs"],
    summary: "Get the organization's anomaly detection thresholds",
    description:
      "The tunable part of cost anomaly detection. Everything else about the model — the " +
      "28-day baseline, the 7-day notification cooldown, the minimum history a baseline needs " +
      "— is fixed. An organization that has never changed a threshold reads back the defaults. " +
      "The response also carries the derived, read-only `smsConfigured`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Anomaly settings",
        content: { "application/json": { schema: CostAnomalySettingsView } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/costs/anomaly-settings",
    tags: ["Costs"],
    summary: "Update the organization's anomaly detection thresholds",
    description:
      "Takes effect on the next detection pass (which runs after each cost collection). " +
      "Anomalies already stored are not re-judged. All four fields are required — this is a " +
      "PUT of the whole settings object, not a patch — and `smsAlerts` deliberately has no " +
      "server-side default, so a client that omits it is rejected rather than silently " +
      "switching an organization's SMS paging back off. `smsConfigured` is derived and is not " +
      "accepted here.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostAnomalySettings } }, required: true },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: CostAnomalySettingsView } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/efficiency-alerts",
    tags: ["Costs"],
    summary: "Recently fired efficiency alerts",
    description:
      "The three slow-lane cost alerts in one feed, newest first: commitments about to lapse, " +
      "commitments that are not being used, and business metrics whose cost per unit rose. " +
      "Unlike budgets, anomalies and change alerts — all of which compare a spend total " +
      "against another spend total — these read the commitment calendar and the volume the " +
      "spend bought, so they see the two surprises the other three structurally cannot.",
    request: {
      params: OrgIdParam,
      query: strict({
        kind: z
          .enum(["commitment_expiry", "commitment_idle", "unit_cost_regression"])
          .optional()
          .describe("Restrict to one detector. Omitted returns all three, interleaved by time."),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Rows to return, newest first. Defaults to 50."),
      }),
    },
    responses: {
      200: {
        description: "Fired efficiency alerts",
        content: {
          "application/json": { schema: strict({ events: z.array(EfficiencyAlertEvent) }) },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/efficiency-alert-settings",
    tags: ["Costs"],
    summary: "Get the organization's efficiency alert tuning",
    description:
      "Thresholds for the commitment-expiry, idle-commitment and unit-cost-regression " +
      "detectors. An organization that has never changed one reads back the defaults, which " +
      "are chosen to work with no setup.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Efficiency alert settings",
        content: { "application/json": { schema: CostEfficiencySettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/costs/efficiency-alert-settings",
    tags: ["Costs"],
    summary: "Update the organization's efficiency alert tuning",
    description:
      "Takes effect on the next evaluation pass (which runs after each cost collection). " +
      "Already-fired alerts are not re-judged, and horizons that have already fired for a " +
      "commitment's current term do not fire again — widening the horizon list warns about " +
      "future crossings, not past ones. A PUT of the whole object, not a patch.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostEfficiencySettings } }, required: true },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: CostEfficiencySettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/status",
    tags: ["Costs"],
    summary: "Per-account cost collection status",
    description:
      "Which accounts support cost collection, whether their history backfill has completed, " +
      "and the ingested date coverage.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Status",
        content: {
          "application/json": { schema: strict({ accounts: z.array(CostAccountStatus) }) },
        },
      },
    },
  });
}

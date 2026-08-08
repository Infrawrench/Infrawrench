import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

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
  topN: z.number().int().min(1).max(15).optional(),
  comparePreviousPeriod: z.boolean().optional(),
  forecast: z.boolean().optional(),
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
export const CostQueryResponse = strict({
  series: z.array(CostQuerySeries),
  comparison: z.array(CostQuerySeries).optional(),
  forecast: z.array(CostSeriesPoint).optional(),
  currencies: z.array(z.string()),
  totals: z.record(z.number()),
  previousTotals: z.record(z.number()).optional(),
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

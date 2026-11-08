/**
 * The cost routes, `/api/org/:orgId/costs`, the endpoint definitions: the cost
 * query and its FOCUS download, the picker values, anomalies and their
 * thresholds, the efficiency detectors, untagged spend, showback and the
 * per-account collection status.
 *
 * The prefix is shared. The anomaly feedback and export job domains serve
 * their own paths under it, and `POST /costs/rows` is the self-authenticating
 * push route, its own domain (`http/domains/cost-ingest/`) outside `OrgAuth`:
 * nothing here is a `/rows` path or a parameter in the first segment, so no
 * request for it is captured.
 *
 * Every route reads cost data, so every one goes through `OrgAuth`, which
 * runs the handler inside the caller's cost visibility scope. Reads are
 * `costs:read`; retuning detection and explaining a finding are `costs:write`.
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { COST_BASES, EFFICIENCY_ALERT_KINDS, FOCUS_VERSIONS } from "@infrawrench/client-core";
import {
  CostAnomalyAcknowledge,
  CostAnomalySettings,
  CostEfficiencySettings,
  CostQueryRequest,
  FocusExportRequest,
  pattern,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { CostAnomaly } from "../../schemas/cost-anomalies";
import { CostAdjustmentSummary, costDay, CostQueryResponse } from "../../schemas/cost-query";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../../schemas/documented";
import { FindingRemediation } from "../../schemas/remediation";

/** A currency code to an amount in its major unit, described for one use. */
const amounts = (description = "Currency code → amount in the currency's major unit.") =>
  Schema.Record(Schema.String, Schema.Finite).annotate({ description });

/** The dimensions `GET /costs/dimensions` answers, plus its three pseudo-dimensions. */
const DIMENSION_QUERY_VALUES = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
  "charge_type",
  "commitment",
  "virtual_tag",
  "tag-keys",
  "usage-units",
  "virtual-tag-keys",
] as const;

export const CostDimensionValues = Schema.Struct({
  values: Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        value: Schema.String,
        label: Schema.String,
        preferred: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "dimension=tag-keys only: the org pins this key (tag key settings). Preferred keys " +
              "come first, in the org's order.",
          }),
        ),
        hidden: Schema.optionalKey(
          Schema.Boolean.annotate({
            description:
              "dimension=tag-keys with includeHidden=true only: the org hides this key from " +
              "pickers. Its data is untouched and filters naming it still work.",
          }),
        ),
      }),
    ]),
  ),
}).annotate({ identifier: "CostDimensionValues" });

export const CostAnomalyList = Schema.Struct({ anomalies: Schema.Array(CostAnomaly) });

/**
 * What the anomaly settings routes answer with: the stored object plus one
 * derived fact, so a client can tell "SMS is on" from "SMS is on and would
 * actually reach somebody" without holding `org:settings:write`.
 */
export const CostAnomalySettingsView = Schema.Struct({
  ...CostAnomalySettings.fields,
  smsConfigured: Schema.Boolean.annotate({
    description:
      "Whether an SMS raised right now could be delivered: paging enabled for the " +
      "organization, Twilio credentials and a from-number stored, and at least one recipient " +
      "opted into SMS. Read-only and derived; it is not accepted on PUT.",
  }),
}).annotate({ identifier: "CostAnomalySettingsView" });

const EfficiencyAlertEvent = Schema.Struct({
  id: Uuid,
  kind: Schema.Literals(EFFICIENCY_ALERT_KINDS).annotate({
    description: "Which detector produced it.",
  }),
  subject: Schema.String.annotate({
    description: "The commitment's description, or the business metric's name.",
  }),
  accountId: Schema.NullOr(Uuid).annotate({
    description: "The account, for commitment kinds; null otherwise.",
  }),
  accountName: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String).annotate({
    description: "ISO 4217 of `amount`, or null when it carries none.",
  }),
  amount: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The money at stake, in **units of `currency`** rather than cents; commitment amounts " +
      "are provider-reported in currency units. Per kind: the monthly on-demand exposure for " +
      "an expiry, the wasted amount for an idle commitment, the current window's spend for a " +
      "regression.",
  }),
  detail: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Null]),
  ).annotate({ description: "Per-kind display facts. Free-form; nothing branches on it." }),
  firedAt: IsoDateTime,
  notifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When the alert reached its routed destinations, or null when nothing was routed (or the " +
      "routing rule held it for quiet hours and the follow-up pass has not run yet).",
  }),
  remediation: Schema.optionalKey(FindingRemediation),
}).annotate({ identifier: "EfficiencyAlertEvent" });

export const EfficiencyAlertEvents = Schema.Struct({ events: Schema.Array(EfficiencyAlertEvent) });

export const UntaggedSpendReport = Schema.Struct({
  from: costDay(),
  to: costDay(),
  requiredKeys: Schema.Array(Schema.String),
  currencies: Schema.Array(Schema.String),
  totals: amounts(),
  untaggedTotals: amounts("Spend on rows missing at least one required tag key, per currency."),
  byKey: Schema.Array(Schema.Struct({ key: Schema.String, untagged: amounts() })),
  topUntagged: Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      accountLabel: Schema.String,
      service: Schema.String,
      currency: Schema.String,
      amount: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "UntaggedSpendReport" });

export const ShowbackReport = Schema.Struct({
  from: costDay(),
  to: costDay(),
  currencies: Schema.Array(Schema.String),
  adjustment: Schema.optionalKey(CostAdjustmentSummary).annotateKey({
    description:
      "Set when `adjusted=true`: the rules in force, the collected totals for the same period, " +
      "and the pro-rated fixed charges. Its absence means every figure above is exactly what " +
      "the providers charged.",
  }),
  centres: Schema.Array(
    Schema.Struct({
      costCentreId: Schema.NullOr(Uuid).annotate({
        description: 'Null for the synthetic "Unallocated" bucket.',
      }),
      name: Schema.String,
      totals: amounts(
        "Spend allocated directly to this centre. A cost row is allocated exactly once, so " +
          "summing this across every entry equals the organization's spend for the period.",
      ),
      subtreeTotals: amounts(
        "This centre's own spend plus every descendant's. Equal to `totals` for a leaf and " +
          "for every centre in an organization that does not nest. Do not sum this across " +
          "entries: parents already contain their children.",
      ),
      parentId: Schema.NullOr(Uuid).annotate({
        description: "The centre this one sits under; null for a root and for Unallocated.",
      }),
      depth: Schema.Int.annotate({ description: "0 for a root; the indentation level." }),
    }),
  ).annotate({
    description:
      "Depth-first: each centre immediately followed by its children, siblings name-sorted, " +
      'with the "Unallocated" bucket last.',
  }),
}).annotate({ identifier: "ShowbackReport" });

const CostAccountStatus = Schema.Struct({
  accountId: Uuid,
  pluginId: Schema.String,
  displayName: Schema.String,
  supportsCosts: Schema.Boolean,
  periodNative: Schema.Boolean,
  dimensions: Schema.Array(Schema.Literals(["service", "region", "resource", "tag"])),
  chargeTypes: Schema.Boolean.annotate({
    description:
      "Whether this account's plugin can tell one kind of charge from another. False means " +
      "every row it writes is recorded as `usage`: not that the provider only bills usage.",
  }),
  amortization: Schema.Boolean.annotate({
    description:
      "Whether this account's plugin reports an amortized amount distinct from the cash " +
      "amount. Clients offer the amortized cost basis only when at least one account says " +
      "yes; elsewhere the amortized view is the cash numbers under another name.",
  }),
  blending: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether this account's plugin reports blended commitment discounts. Clients offer the " +
        "blended cost basis only when at least one account says yes; elsewhere it reads as " +
        "the amortized numbers.",
    }),
  ),
  estimated: Schema.Boolean.annotate({
    description:
      "Whether this account's amounts are derived by Infrawrench (inventory priced against a " +
      "rate card, or metered usage priced at published list rates) rather than reported as " +
      "billed spend. True means the series cannot be reconciled against an invoice: resources " +
      "deleted part-way through a period are no longer in inventory to be priced, all rates " +
      "are list rather than negotiated, and credits, tax and refunds never appear.",
  }),
  granularity: Schema.Literals(["daily", "hourly"]).annotate({
    description:
      "The granularity this account's cost rows are stored at. `daily` for every provider " +
      "today; hourly bins are offered only once some account reports `hourly`.",
  }),
  costLastPolledAt: Schema.NullOr(IsoDateTime),
  costBackfilledAt: Schema.NullOr(IsoDateTime),
  costPollFailureCount: Schema.Int,
  costPollError: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      helpLink: Schema.NullOr(Schema.Struct({ label: Schema.String, url: Schema.String })),
    }),
  ).annotate({
    description:
      "Last cost-collection failure for this account, cleared on the next success. " +
      "`helpLink` points at the provider page that fixes a setup problem when the " +
      "plugin can identify one (e.g. GCP's billing export console).",
  }),
  coverage: Schema.NullOr(Schema.Struct({ firstDay: costDay(), lastDay: costDay() })),
}).annotate({ identifier: "CostAccountStatus" });

export const CostStatus = Schema.Struct({ accounts: Schema.Array(CostAccountStatus) });

/** The FOCUS CSV, streamed. */
const FocusCsv = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }));

/** Says which header the FOCUS body carries; set by the handler, documented here. */
const focusVersionHeader = (operation: Record<string, unknown>): Record<string, unknown> => {
  const responses = operation["responses"];
  if (!Predicate.isObject(responses) || !Predicate.isObject(responses["200"])) return operation;
  return {
    ...operation,
    responses: {
      ...responses,
      "200": {
        ...responses["200"],
        headers: {
          "X-Focus-Version": {
            description: "The FOCUS version the body is written in (`1.4` or `1.3`).",
            schema: { type: "string", enum: [...FOCUS_VERSIONS] },
          },
        },
      },
    },
  };
};

/**
 * `?from&to` (both `YYYY-MM-DD`, defaulting to the trailing 30 days) and
 * `?basis=`, read as sent: the handler answers a bad range with its own
 * sentence, and reads an unknown basis as cash.
 */
const rangeQuery = {
  from: Schema.optionalKey(documentedAs(costDay({ description: "Defaults to 30 days ago." }))),
  to: Schema.optionalKey(documentedAs(costDay({ description: "Defaults to today." }))),
  basis: Schema.optionalKey(
    documentedAs(
      Schema.Literals(COST_BASES).annotate({
        description:
          "Which money to sum. `cash` (the default) is what the provider charged on the day it " +
          "charged it; `amortized` spreads a commitment's up-front fee across the term it buys; " +
          "`blended` also spreads each commitment's discount evenly over all the usage it could " +
          "cover. Providers that report no amortized amount fall back to their cash amount.",
      }),
    ),
  ),
};

export class CostsGroup extends HttpApiGroup.make("costs")
  .add(
    HttpApiEndpoint.post("query", "/query", {
      params: OrgParams,
      payload: CostQueryRequest,
      success: CostQueryResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Query aggregated cost series")
      .annotate(
        OpenApi.Description,
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
      )
      .annotate(SuccessDescription, "Cost series")
      .annotate(InvalidRequestMessage, "Invalid query"),
    HttpApiEndpoint.post("focusExport", "/focus-export", {
      params: OrgParams,
      payload: FocusExportRequest,
      success: FocusCsv,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Download cost rows as a FOCUS CSV")
      .annotate(
        OpenApi.Description,
        "The rows a cost query selects, written as a CSV in the FinOps Open Cost and Usage " +
          "Specification (FOCUS) layout of `version` (`1.4` or `1.3`; omitted means `1.3`, so " +
          "scripts written before 1.4 keep their header). One row per account, service, region, resource, tag " +
          "set, charge type and commitment per day, with `BilledCost` (cash) and `EffectiveCost` " +
          "(amortized) side by side, `ChargeCategory`, `ServiceCategory`/`ServiceSubcategory`, " +
          "`Tags` as a JSON object and the commitment columns where the provider reports a " +
          "commitment. Custom columns follow, prefixed `x_`. 1.4 drops the deprecated " +
          "`ProviderName` and `PublisherName` (`ServiceProviderName` and `HostProviderName` carry " +
          "the same value) and sets `EffectiveCost` to `BilledCost` on tax rows. The same mapping a " +
          "`focus-<version>` scheduled export writes (see /cost-exports).\n\n" +
          "Takes the cost query's filter in either spelling (`filters` or `query`, never both), an " +
          "optional saved filter, and charge types. The range spans at most 366 days; for anything " +
          "longer, or for a recurring feed, use a scheduled export. Validation errors are a 400 " +
          "before any CSV is written; the body is then streamed.",
      )
      .annotate(OpenApi.Transform, focusVersionHeader)
      .annotate(SuccessDescription, "FOCUS CSV, with a header row"),
    HttpApiEndpoint.get("dimensions", "/dimensions", {
      params: OrgParams,
      query: {
        dimension: Schema.optionalKey(documentedAs(Schema.Literals(DIMENSION_QUERY_VALUES))),
        tagKey: Schema.optionalKey(Schema.String),
        includeHidden: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["true", "false"]).annotate({
              description:
                "dimension=tag-keys only: also list keys the org hides, flagged `hidden`.",
            }),
          ),
        ),
      },
      success: CostDimensionValues,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List distinct values for a cost dimension")
      .annotate(
        OpenApi.Description,
        "Feeds the filter and group-by pickers. Pass dimension=tag-keys for tag keys, which " +
          "follow the org's tag key settings (preferred keys first and flagged, hidden keys " +
          "omitted unless includeHidden=true), dimension=virtual-tag-keys for the organization's " +
          "virtual tag keys (labelled by name), or dimension=usage-units for the usage units " +
          "providers report (a usage budget's unit); dimension=tag and dimension=virtual_tag " +
          "require tagKey. `charge_type` answers from the fixed set of charge " +
          "types rather than from the stored data, so the picker is populated before any " +
          "provider has reported one. `usage-units` lists the usage units present in the cost " +
          "data, most common first, for the `usage` measure's unit picker.",
      )
      .annotate(OpenApi.Transform, requiredQuery(["dimension"]))
      .annotate(SuccessDescription, "Values"),
    HttpApiEndpoint.get("anomalies", "/anomalies", {
      params: OrgParams,
      query: {
        days: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({
              description: "Window in days over anomalous days, 1-90. Defaults to 30.",
            }).check(pattern(/^\d+$/)),
          ),
        ),
      },
      success: CostAnomalyList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List recently detected cost anomalies")
      .annotate(
        OpenApi.Description,
        "Spend anomalies detected by the daily background pass. Two kinds share the list: a " +
          "`spike`, where a provider's or service's spend exceeded its trailing 28-day baseline " +
          "by a statistical threshold (mean + N·stddev, with an absolute floor to ignore " +
          "penny-scale noise), and a `new_source`, where a provider or service with no spend at " +
          "all across that window suddenly billed a material amount. Thresholds are per " +
          "organization: see GET /costs/anomaly-settings. Newest day first, capped at 200 rows.",
      )
      .annotate(SuccessDescription, "Anomalies"),
    HttpApiEndpoint.post("acknowledgeAnomaly", "/anomalies/:anomalyId/acknowledge", {
      params: { orgId: OrgId, anomalyId: Schema.String },
      payload: CostAnomalyAcknowledge,
      success: CostAnomaly,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Explain a detected cost anomaly")
      .annotate(
        OpenApi.Description,
        "Record what a finding actually was, and publish that sentence as a cost annotation on " +
          "**every** chart covering the anomalous day; the point being that 'we migrated the " +
          "fleet' is not a fact about whichever report somebody happened to open. The note's date " +
          "(the anomalous day) and its org-wide scope are derived from the anomaly and are not the " +
          "caller's to choose.\n\n" +
          "The reply is the updated anomaly, carrying `acknowledgement` with the id of the note it " +
          "created. Sending it again replaces the sentence and rewords that note rather than " +
          "filing a second one; it will not recreate a note that has since been deleted, since " +
          "deleting a note is a deliberate act and the finding stays explained without it.\n\n" +
          "This does not suppress detection. If the same provider or service spikes again on a " +
          "later day, that is a new anomaly and it is detected and alerted on as normal.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "The acknowledged anomaly")
      .annotate(InvalidRequestMessage, "Invalid acknowledgement"),
    HttpApiEndpoint.get("anomalySettings", "/anomaly-settings", {
      params: OrgParams,
      success: CostAnomalySettingsView,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get the organization's anomaly detection thresholds")
      .annotate(
        OpenApi.Description,
        "The tunable part of cost anomaly detection. Everything else about the model (the " +
          "28-day baseline, the 7-day notification cooldown, the minimum history a baseline needs " +
          ") is fixed. An organization that has never changed a threshold reads back the defaults. " +
          "The response also carries the derived, read-only `smsConfigured`.",
      )
      .annotate(SuccessDescription, "Anomaly settings"),
    HttpApiEndpoint.put("updateAnomalySettings", "/anomaly-settings", {
      params: OrgParams,
      payload: CostAnomalySettings,
      success: CostAnomalySettingsView,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update the organization's anomaly detection thresholds")
      .annotate(
        OpenApi.Description,
        "Takes effect on the next detection pass (which runs after each cost collection). " +
          "Anomalies already stored are not re-judged. The four threshold fields are required (this is a " +
          "PUT of the whole settings object, not a patch) and `smsAlerts` deliberately has no " +
          "server-side default, so a client that omits it is rejected rather than silently " +
          "switching an organization's SMS paging back off. `smsConfigured` is derived and is not " +
          "accepted here.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(InvalidRequestMessage, "Invalid anomaly settings"),
    HttpApiEndpoint.get("efficiencyAlerts", "/efficiency-alerts", {
      params: OrgParams,
      query: {
        kind: Schema.optionalKey(
          documentedAs(
            Schema.Literals(EFFICIENCY_ALERT_KINDS).annotate({
              description:
                "Restrict to one detector. Omitted returns all three, interleaved by time.",
            }),
          ),
        ),
        limit: Schema.optionalKey(
          documentedAs(
            Schema.Int.annotate({
              description: "Rows to return, newest first. Defaults to 50.",
            }).check(Schema.isBetween({ minimum: 1, maximum: 200 })),
          ),
        ),
      },
      success: EfficiencyAlertEvents,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Recently fired efficiency alerts")
      .annotate(
        OpenApi.Description,
        "The three slow-lane cost alerts in one feed, newest first: commitments about to lapse, " +
          "commitments that are not being used, and business metrics whose cost per unit rose. " +
          "Unlike budgets, anomalies and change alerts (all of which compare a spend total " +
          "against another spend total) these read the commitment calendar and the volume the " +
          "spend bought, so they see the two surprises the other three structurally cannot.",
      )
      .annotate(SuccessDescription, "Fired efficiency alerts"),
    HttpApiEndpoint.get("efficiencyAlertSettings", "/efficiency-alert-settings", {
      params: OrgParams,
      success: CostEfficiencySettings,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get the organization's efficiency alert tuning")
      .annotate(
        OpenApi.Description,
        "Thresholds for the commitment-expiry, idle-commitment and unit-cost-regression " +
          "detectors. An organization that has never changed one reads back the defaults, which " +
          "are chosen to work with no setup.",
      )
      .annotate(SuccessDescription, "Efficiency alert settings"),
    HttpApiEndpoint.put("updateEfficiencyAlertSettings", "/efficiency-alert-settings", {
      params: OrgParams,
      payload: CostEfficiencySettings,
      success: CostEfficiencySettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update the organization's efficiency alert tuning")
      .annotate(
        OpenApi.Description,
        "Takes effect on the next evaluation pass (which runs after each cost collection). " +
          "Already-fired alerts are not re-judged, and horizons that have already fired for a " +
          "commitment's current term do not fire again; widening the horizon list warns about " +
          "future crossings, not past ones. A PUT of the whole object, not a patch.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(InvalidRequestMessage, "Invalid efficiency alert settings"),
    HttpApiEndpoint.get("untagged", "/untagged", {
      params: OrgParams,
      query: rangeQuery,
      success: UntaggedSpendReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Untagged spend over the required tag keys")
      .annotate(
        OpenApi.Description,
        "Spend on cost rows missing at least one of the org's required tag keys, overall and per " +
          "key, plus the largest untagged (account, service) buckets. Empty when no tag policy is " +
          "configured: untagged is only meaningful against a policy.",
      )
      .annotate(SuccessDescription, "Untagged spend report"),
    // `?currency=` (the opt-in display currency) is read by the handler but was
    // never documented; it stays that way.
    HttpApiEndpoint.get("showback", "/showback", {
      params: OrgParams,
      query: {
        ...rangeQuery,
        adjusted: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["true", "false"]).annotate({
              description:
                "Apply the organization's billing rules (see /billing-rules): markups multiply, and a " +
                "reallocation moves a centre's spend onto another centre. Off by default; a chargeback " +
                "report that silently showed marked-up numbers is one the receiving team could not " +
                "reconcile. On, the response carries `adjustment` with the collected totals beside the " +
                "adjusted ones. Fixed-amount rules are booked onto the cost centre they name (or " +
                '"Unallocated" when they name none), pro-rated across the period.',
            }),
          ),
        ),
      },
      success: ShowbackReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Spend grouped by cost centre (showback)")
      .annotate(
        OpenApi.Description,
        "Runs the org's allocation rules over collected spend and sums per cost centre and " +
          'currency. Spend no rule claims comes back as the "Unallocated" bucket; every defined ' +
          "centre appears even with zero spend.\n\n" +
          "Cost centres nest, so the list is a depth-first tree. Each entry carries `totals` (spend " +
          "allocated directly to it) and `subtreeTotals` (its own plus every descendant's). " +
          '"Engineering, of which Platform" needs both. Rules still evaluate first-match-wins by ' +
          "ascending priority against a flat list, so a row is allocated exactly once even when a " +
          "rule targets a parent and another targets its child; at equal priority the more deeply " +
          "nested centre wins.",
      )
      .annotate(SuccessDescription, "Showback report"),
    HttpApiEndpoint.get("status", "/status", {
      params: OrgParams,
      success: CostStatus,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Per-account cost collection status")
      .annotate(
        OpenApi.Description,
        "Which accounts support cost collection, whether their history backfill has completed, " +
          "and the ingested date coverage.",
      )
      .annotate(SuccessDescription, "Status"),
  )
  .prefix("/api/org/:orgId/costs")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Costs") {}

export class CostsApi extends withApiDefaults(HttpApi.make("costs").add(CostsGroup)) {}

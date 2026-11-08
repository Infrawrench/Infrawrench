/**
 * Billing rules: `/api/org/:orgId/billing-rules`, the endpoint definitions.
 *
 * The org's own adjustments to collected spend.
 *
 * ## The permission split, and why it is not `costs:write`
 *
 * Reads ride `costs:read` like every other cost surface: a rule is part of the
 * explanation for a number, and hiding it from the people who read the number
 * would make every adjusted figure unauditable.
 *
 * Writes ride **`org:settings:write`**, not `costs:write`, and that is the
 * deliberate part. `costs:write` is the "name a report, define a cost centre,
 * save a filter" scope: acts that add a view of the org's spend. A billing
 * rule is not a view: it changes what every internal figure in the
 * organisation says, in the Costs panel, in an opted-in budget's thresholds, in
 * a chargeback statement a finance team sends to another department. Somebody
 * who can build cost reports should not thereby be able to add 15% to every
 * number the org reports about itself.
 *
 * This is the same reasoning `PUT /currency` and `POST /cost-exports` already
 * follow (stating an exchange rate restates every total, and creating an
 * export ships the billing history somewhere) and it puts all three of the
 * "this changes the org's money story" acts behind one scope.
 *
 * The bodies are the shared schemas the billing rule editor validates with
 * (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  BillingRuleAdjustment,
  BillingRuleInput,
  BillingRuleMatch,
  BillingRuleReorder,
  PricingPreviewRequest,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { PricingEffect, PricingExpressionFailure, RerateCoverage } from "../../schemas/pricing";

export const BillingRule = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  priority: Schema.Int,
  match: BillingRuleMatch,
  adjustment: BillingRuleAdjustment,
  managedAccountIds: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "BillingRule" });

const CurrencyMap = Schema.Record(Schema.String, Schema.Finite);

export const PricingPreviewResult = Schema.Struct({
  month: Schema.String,
  from: Schema.String,
  to: Schema.String,
  managedAccountId: Schema.NullOr(Schema.String),
  collected: CurrencyMap,
  before: CurrencyMap.annotate({
    description:
      "Priced without the candidate: the saved rules minus `ruleId`, with the saved settings.",
  }),
  after: CurrencyMap.annotate({ description: "Priced with the candidate swapped in." }),
  effects: Schema.Array(PricingEffect),
  coverage: Schema.NullOr(RerateCoverage),
  warnings: Schema.Array(Schema.String),
  expressionFailures: Schema.Array(PricingExpressionFailure),
  changes: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      service: Schema.String,
      accountName: Schema.String,
      chargeType: Schema.String,
      currency: Schema.String,
      collected: Schema.Finite,
      before: Schema.Finite,
      after: Schema.Finite,
    }),
  ).annotate({ description: "The lines that moved most, largest change first, at most 25." }),
  lineCount: Schema.Int,
}).annotate({ identifier: "PricingPreviewResult" });

export class BillingRulesGroup extends HttpApiGroup.make("billingRules")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(BillingRule),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List billing rules in evaluation order")
      .annotate(
        OpenApi.Description,
        "Billing rules are the organisation's own adjustments to collected spend; a markup that " +
          "recovers shared overhead, a discount negotiated outside the provider's pricing, a shared " +
          "cluster reallocated onto the teams that use it.\n\n" +
          "**They are applied at query time and never written into stored cost data.** Collected " +
          "spend stays exactly what the provider reported, so it can still be reconciled against an " +
          "invoice, and editing or deleting a rule restates nothing.",
      )
      .annotate(SuccessDescription, "Rules, ascending priority then creation time"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: BillingRuleInput,
      success: BillingRule,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a billing rule")
      .annotate(
        OpenApi.Description,
        "Requires `org:settings:write` rather than `costs:write`: a billing rule changes every " +
          "figure the organisation reports about itself, which is a governance act on the scale of " +
          "stating an exchange rate, not the scale of saving a report.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid billing rule"),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: PricingPreviewRequest,
      success: PricingPreviewResult,
      error: [BadRequest, Forbidden, Conflict],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Preview a rule or customer pricing against a month of spend")
      .annotate(
        OpenApi.Description,
        "Prices one calendar month (last month by default) twice: with the saved rules and " +
          "settings, and with the candidate rule or customer settings swapped in. Nothing is " +
          "written. Returns both totals, every effect, re-rating coverage, any expression failures " +
          "and the lines that moved most.\n\n" +
          "Requires `costs:read`, and `invoices:read` as well when a customer is named.",
      )
      .annotate(SuccessDescription, "The preview")
      .annotate(InvalidRequestMessage, "Invalid preview request"),
    HttpApiEndpoint.post("reorder", "/reorder", {
      params: OrgParams,
      payload: BillingRuleReorder,
      success: Schema.Array(BillingRule),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Reorder billing rules")
      .annotate(
        OpenApi.Description,
        "Rewrites every rule's priority to match the given order (10, 20, 30…) in one " +
          "transaction and one audit entry. The list must name every rule exactly once.",
      )
      .annotate(SuccessDescription, "The rules in their new order")
      .annotate(InvalidRequestMessage, "Invalid order"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: BillingRule,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a billing rule")
      .annotate(SuccessDescription, "The rule"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: BillingRuleInput,
      success: BillingRule,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a billing rule")
      .annotate(
        OpenApi.Description,
        "A full replace, `enabled` included; switching a markup off is an edit of the rule, so " +
          "there is one audited action for “this rule changed” rather than two.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid billing rule"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a billing rule")
      .annotate(
        OpenApi.Description,
        "Nothing cascades and nothing is restated: no adjustment was ever written into stored " +
          "cost data, so the next read simply computes without this rule.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/billing-rules")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Billing Rules") {}

export class BillingRulesApi extends withApiDefaults(
  HttpApi.make("billing-rules").add(BillingRulesGroup),
) {}

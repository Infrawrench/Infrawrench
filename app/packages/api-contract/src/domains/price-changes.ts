/**
 * Price changes: `/api/org/:orgId/price-changes`, the endpoint definitions.
 * Filed under the Price catalog tag, beside the list prices they change.
 *
 * The org's changes are `costs:read` (each carries a monthly figure for the
 * org's own resources); the catalog-wide list is `resources:read`, like the
 * price catalog it extends. The settings follow the other alert radars:
 * `org:settings:write`, because the thresholds decide what the org's
 * channels hear about. Making a scenario model is `costs:write`, the scenario
 * models' own permission.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { PRICE_CHANGE_LIMITS } from "@infrawrench/client-core";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";
import { numericQuery } from "../http/schemas/query";

const PriceChangeResource = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  displayName: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  units: Schema.Int.annotate({ description: "Instances, nodes or GPUs of the type it runs." }),
  approximate: Schema.Boolean.annotate({
    description: "True when `units` is a lower bound (a cluster whose node count is not synced).",
  }),
}).annotate({ identifier: "PriceChangeResource" });

export const PriceChange = Schema.Struct({
  id: Uuid,
  pluginId: PluginId,
  platform: Schema.String.annotate({
    description: "The pricing warehouse's platform: `ec2`, `rds`, `azure`, `gcp`...",
    examples: ["ec2"],
  }),
  instanceType: Schema.String.annotate({ examples: ["m5.large"] }),
  region: Schema.String.annotate({ examples: ["us-east-1"] }),
  selection: Schema.Record(Schema.String, Schema.String).annotate({
    description:
      "The variant matched (operating system, database engine...), keyed by the warehouse's " +
      "`prices` columns or `variant.<key>`.",
  }),
  oldHourlyUsd: Schema.Finite,
  newHourlyUsd: Schema.Finite,
  percent: Schema.Finite.annotate({ description: "(new / old - 1) x 100." }),
  effectiveAt: IsoDateTime.annotate({ description: "When the new price takes or took effect." }),
  upcoming: Schema.Boolean.annotate({ description: "True while `effectiveAt` is in the future." }),
  units: Schema.Int,
  approximate: Schema.Boolean,
  monthlyImpactUsd: Schema.Finite.annotate({
    description:
      "(new - old) x 730 hours x units: what the change does to the organization's month at " +
      "list price. Negative for a cut.",
  }),
  resources: Schema.Array(PriceChangeResource).annotate({
    description: "The affected resources (at most 50 named; the figure covers all of them).",
  }),
  belowThreshold: Schema.Boolean.annotate({
    description: "True when it falls under the organization's thresholds: listed, never alerted.",
  }),
  alertedAt: Schema.NullOr(IsoDateTime),
  suppressionIds: Schema.Array(Uuid).annotate({
    description: "Anomaly suppressions registered so detection does not fire on the step.",
  }),
  scenarioModelId: Schema.NullOr(Uuid).annotate({
    description: "The scenario model made from this change, while it exists.",
  }),
  detectedAt: IsoDateTime,
  pageUrl: Schema.String.annotate({ description: "The instance's page with its price history." }),
}).annotate({ identifier: "PriceChange" });

export const PriceChangeListResponse = Schema.Struct({
  changes: Schema.Array(PriceChange).annotate({ description: "Newest effective date first." }),
  available: Schema.Boolean.annotate({
    description: "False when the server has no pricing warehouse to read price history from.",
  }),
  lastScannedAt: Schema.NullOr(IsoDateTime),
  minMonthlyImpactCents: Schema.Int,
  minPercent: Schema.Finite,
}).annotate({ identifier: "PriceChangeListResponse" });

const CatalogPriceChange = Schema.Struct({
  platform: Schema.String,
  instanceType: Schema.String,
  region: Schema.String,
  variant: Schema.String.annotate({
    description: "The variant in words (`PostgreSQL, Multi-AZ`); empty for a plain instance.",
  }),
  oldHourlyUsd: Schema.Finite,
  newHourlyUsd: Schema.Finite,
  percent: Schema.Finite,
  effectiveAt: IsoDateTime,
  vcpu: Schema.NullOr(Schema.Finite),
  memoryGib: Schema.NullOr(Schema.Finite),
  pageUrl: Schema.String,
}).annotate({ identifier: "CatalogPriceChange" });

export const CatalogPriceChangeResponse = Schema.Struct({
  available: Schema.Boolean,
  platforms: Schema.Array(Schema.String).annotate({
    description: "Every platform the warehouse prices.",
  }),
  platform: Schema.String,
  days: Schema.Int,
  changes: Schema.Array(CatalogPriceChange).annotate({ description: "Newest first." }),
  truncated: Schema.Boolean,
}).annotate({ identifier: "CatalogPriceChangeResponse" });

export const PriceChangeSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the daily scan (and so its alerts) runs. Default true.",
  }),
  minMonthlyImpactCents: Schema.Int.annotate({
    description:
      "Changes moving the organization's month by less than this, in cents of USD, are not " +
      "alerted. Default 1000 ($10).",
  }),
  minPercent: Schema.Finite.annotate({
    description: "Changes under this percentage of the old price are not alerted. Default 1.",
  }),
  registerExpected: Schema.Boolean.annotate({
    description:
      "Register an alerted increase as expected (a one-off anomaly suppression per affected " +
      "account) so anomaly detection does not fire on the step. Default true.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the last daily scan completed. Owned by the poller; read-only.",
  }),
}).annotate({ identifier: "PriceChangeSettings" });

const { minMonthlyImpactCents: centsBounds, minPercent: percentBounds } = PRICE_CHANGE_LIMITS;

export const PriceChangeSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  minMonthlyImpactCents: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: centsBounds.min, maximum: centsBounds.max })),
  ),
  minPercent: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isBetween({ minimum: percentBounds.min, maximum: percentBounds.max }),
    ),
  ),
  registerExpected: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PriceChangeSettingsUpdate" });

export const PriceChangeScenarioResponse = Schema.Struct({
  scenarioModelId: Uuid,
  created: Schema.Boolean.annotate({
    description: "False when the change already had a scenario model, which is returned.",
  }),
}).annotate({ identifier: "PriceChangeScenarioResponse" });

const ChangeParams = { orgId: OrgParams.orgId, changeId: Uuid } as const;

export class PriceChangesGroup extends HttpApiGroup.make("priceChanges")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        days: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({
              description: `How far back, in days. Default ${PRICE_CHANGE_LIMITS.listDays.default}.`,
            }),
          ),
        ),
      },
      success: PriceChangeListResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List list-price changes on instance types the organization runs")
      .annotate(
        OpenApi.Description,
        "One row per change (never per resource): the instance type, region and variant, the old " +
          "and new hourly list price, when it took or takes effect, which of the organization's " +
          "resources run it and what it does to their month. Found by a daily scan of the pricing " +
          "warehouse's price history.",
      )
      .annotate(
        OpenApi.Transform,
        numericQuery({
          days: { type: "integer", minimum: 1, maximum: PRICE_CHANGE_LIMITS.listDays.max },
        }),
      )
      .annotate(SuccessDescription, "Price changes"),
    HttpApiEndpoint.get("catalog", "/catalog", {
      params: OrgParams,
      query: {
        platform: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({
              description: "The warehouse platform (`ec2`, `rds`, `azure`, `gcp`...). Default `ec2`.",
            }),
          ),
        ),
        days: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({
              description: `How far back, in days. Default ${PRICE_CHANGE_LIMITS.catalogDays.default}.`,
            }),
          ),
        ),
      },
      success: CatalogPriceChangeResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List every list-price change on one platform")
      .annotate(
        OpenApi.Description,
        "Every on-demand list-price change on a platform over the last `days`, whether or not the " +
          "organization runs the instance type: the headline variant only (Linux, shared tenancy, " +
          "standard priority). Cached for an hour.",
      )
      .annotate(
        OpenApi.Transform,
        numericQuery({
          days: { type: "integer", minimum: 1, maximum: PRICE_CHANGE_LIMITS.catalogDays.max },
        }),
      )
      .annotate(SuccessDescription, "Catalog price changes"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: PriceChangeSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's price-change watch settings")
      .annotate(
        OpenApi.Description,
        "An organization that never saved reads the shipped defaults (enabled, $10 a month, 1%, " +
          "registering increases as expected).",
      )
      .annotate(SuccessDescription, "Price-change watch settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: PriceChangeSettingsUpdate,
      success: PriceChangeSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the price-change watch settings")
      .annotate(
        OpenApi.Description,
        `Every field is optional. \`minMonthlyImpactCents\` is a whole number from ${centsBounds.min} ` +
          `to ${centsBounds.max}; \`minPercent\` is from ${percentBounds.min} to ${percentBounds.max}. ` +
          "Saving never resets the scan's cooldown.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("createScenario", "/:changeId/scenario", {
      params: ChangeParams,
      success: PriceChangeScenarioResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Make a scenario model from a price change")
      .annotate(
        OpenApi.Description,
        "Creates a scenario model in USD with one recurring monthly amount (the change's monthly " +
          "impact) from the day it takes effect, scoped to the change's provider and the accounts " +
          "running it, so forecasts can show it before the trend catches up. Calling it again " +
          "returns the model already made, while it exists.",
      )
      .annotate(SuccessDescription, "The scenario model"),
  )
  .prefix("/api/org/:orgId/price-changes")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Price catalog") {}

export class PriceChangesApi extends withApiDefaults(
  HttpApi.make("priceChanges").add(PriceChangesGroup),
) {}

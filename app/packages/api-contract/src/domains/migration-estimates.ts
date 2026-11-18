/**
 * Migration estimates: `/api/org/:orgId/migration-estimates`, the endpoint
 * definitions. "What would this service cost on provider X?": each resource
 * matched to the target's type of the same category, sized at least as large
 * as it is now, and priced from the target's published list prices beside
 * what the resource costs today.
 *
 * Reading and computing is `costs:read` (the current side is the org's billed
 * spend, read inside the caller's cost visibility scope). Saving, replacing,
 * deleting and turning an estimate into a scenario model are cost-object
 * edits, `costs:write`. Only an estimate's inputs are stored; its figures are
 * computed on every read.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  MigrationEstimateInput,
  MigrationEstimateSource,
  MigrationRowOverride,
  MigrationScenarioInput,
  STRICT_PARSE_OPTIONS,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";

const strictBody = { ...STRICT_PARSE_OPTIONS, errors: "all" } as const;

const Area = Schema.Literals([
  "north-america",
  "south-america",
  "europe",
  "asia-pacific",
  "middle-east",
  "africa",
  "oceania",
]).annotate({ identifier: "MigrationArea" });

const Category = Schema.Literals([
  "vm",
  "kubernetes-cluster",
  "kubernetes-node-pool",
  "managed-postgres",
  "managed-mysql",
  "managed-redis",
  "managed-mongodb",
  "object-storage",
  "block-volume",
  "file-storage",
  "load-balancer",
  "container-app",
  "serverless-function",
  "container-registry",
  "static-ip",
  "dns-zone",
]).annotate({
  identifier: "MigrationCategory",
  description:
    "What a resource is across providers, as its plugin declares it. Resources are matched to " +
    "the target's type of the same category.",
});

const Money = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.String.annotate({ examples: ["USD"] }),
}).annotate({ identifier: "MigrationMoney" });

const Cost = Schema.Struct({
  amount: Schema.Finite.annotate({ description: "Per month (730 hours)." }),
  currency: Schema.String,
  basis: Schema.Literals(["billed", "estimate", "list-price"]).annotate({
    description:
      "`billed`: the resource's own spend in collected cost data over the last 30 days, scaled " +
      "to 730 hours. `estimate`: the plugin's estimate for the configuration. `list-price`: the " +
      "size's published list price times the count.",
  }),
  partial: Schema.Boolean.annotate({
    description: "Only part of the resource could be priced; the true figure is higher.",
  }),
}).annotate({ identifier: "MigrationCost" });

const SizeOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  vcpus: Schema.NullOr(Schema.Finite),
  memoryGb: Schema.NullOr(Schema.Finite),
  gpuCount: Schema.NullOr(Schema.Finite),
  gpuModel: Schema.NullOr(Schema.String),
  monthly: Schema.NullOr(Money).annotate({ description: "One unit, per month; null if unpriced." }),
  meetsSpec: Schema.Boolean.annotate({
    description: "Meets or exceeds the source's known vCPUs, memory and GPUs.",
  }),
}).annotate({ identifier: "MigrationSizeOption" });

const Row = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Schema.String,
  category: Category,
  sourceRegion: Schema.NullOr(Schema.String),
  sourceArea: Schema.NullOr(Area),
  instanceType: Schema.NullOr(Schema.String),
  specs: Schema.Struct({
    vcpus: Schema.NullOr(Schema.Finite),
    memoryGb: Schema.NullOr(Schema.Finite),
    gpuCount: Schema.NullOr(Schema.Finite),
    gpuModel: Schema.NullOr(Schema.String),
    diskGb: Schema.NullOr(Schema.Finite),
    count: Schema.Finite,
  }),
  current: Schema.NullOr(Cost).annotate({
    description: "What it costs now; null when nothing can price it (never 0).",
  }),
  target: Schema.Struct({
    resourceTypeId: Schema.String,
    resourceTypeName: Schema.String,
    sizeId: Schema.NullOr(Schema.String),
    sizeLabel: Schema.NullOr(Schema.String),
    vcpus: Schema.NullOr(Schema.Finite),
    memoryGb: Schema.NullOr(Schema.Finite),
    gpuCount: Schema.NullOr(Schema.Finite),
    region: Schema.NullOr(Schema.String),
    regionLabel: Schema.NullOr(Schema.String),
    cost: Schema.NullOr(Cost),
    overridden: Schema.Boolean,
  }),
  note: Schema.NullOr(
    Schema.Literals([
      "no-account",
      "source-size-unknown",
      "no-size-match",
      "no-price",
      "catalog-unavailable",
    ]),
  ).annotate({ description: "Why the target has no figure, when it has none." }),
  candidates: Schema.Array(SizeOption).annotate({
    description: "Target sizes for the picker: qualifying first, cheapest first.",
  }),
  targetTypes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
}).annotate({ identifier: "MigrationRow" });

const Unmatched = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  category: Schema.NullOr(Category),
  reason: Schema.Literals(["no-category", "no-target-type"]),
  current: Schema.NullOr(Cost),
}).annotate({ identifier: "MigrationUnmatchedRow" });

const Totals = Schema.Struct({
  current: Schema.Array(Money),
  target: Schema.Array(Money),
  currentUnknown: Schema.Int,
  targetUnknown: Schema.Int,
  unmatchedCurrent: Schema.Array(Money),
  comparable: Schema.NullOr(
    Schema.Struct({
      currency: Schema.String,
      current: Schema.Finite,
      target: Schema.Finite,
      pairedDelta: Schema.Finite.annotate({
        description:
          "Target minus current over the rows priced on both sides. Negative saves money.",
      }),
      pairedRows: Schema.Int,
    }),
  ).annotate({
    description:
      "Every figure in one currency (the org's display currency, or the one currency all " +
      "figures are in); null when they cannot be converted.",
  }),
}).annotate({ identifier: "MigrationTotals" });

export const MigrationEstimateResult = Schema.Struct({
  estimateId: Schema.NullOr(Uuid),
  name: Schema.String,
  source: Schema.Struct({
    kind: Schema.Literals(["service", "resources"]),
    label: Schema.String,
    resourceCount: Schema.Int,
  }),
  target: Schema.Struct({ pluginId: PluginId, pluginName: Schema.String }),
  region: Schema.Struct({
    region: Schema.NullOr(Schema.String),
    regionLabel: Schema.NullOr(Schema.String),
    area: Schema.NullOr(Area),
    sourceAreas: Schema.Array(Area),
    choice: Schema.Literals(["user", "nearest", "default", "none"]),
    crossesArea: Schema.NullOr(Schema.Boolean).annotate({
      description: "Some sources are in another area than the target region; null if unknown.",
    }),
  }).annotate({ identifier: "MigrationRegionNote" }),
  rows: Schema.Array(Row),
  unmatched: Schema.Array(Unmatched),
  totals: Totals,
  displayCurrency: Schema.NullOr(Schema.String),
  terraform: Schema.Boolean.annotate({
    description: "The target plugin can write Terraform for at least one matched row.",
  }),
  truncated: Schema.Boolean,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "MigrationEstimateResult" });

export const MigrationEstimate = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  source: MigrationEstimateSource,
  sourceName: Schema.NullOr(Schema.String),
  targetPluginId: Schema.String,
  targetRegion: Schema.NullOr(Schema.String),
  overrides: Schema.Record(Schema.String, MigrationRowOverride),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "MigrationEstimate" });

export const MigrationTargetProvider = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  categories: Schema.Array(Category),
  regions: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, area: Schema.NullOr(Area) }),
  ),
  priceCatalog: Schema.Boolean,
  needsAccount: Schema.Boolean.annotate({
    description: "Pricing on this provider needs one of the org's accounts on it.",
  }),
  hasAccount: Schema.Boolean,
  terraform: Schema.Boolean,
}).annotate({ identifier: "MigrationTargetProvider" });

export const MigrationTargets = Schema.Struct({
  providers: Schema.Array(MigrationTargetProvider),
}).annotate({ identifier: "MigrationTargets" });

export const MigrationTerraformResult = Schema.Struct({
  hcl: Schema.String,
  exported: Schema.Array(Schema.Struct({ resourceId: Schema.String, address: Schema.String })),
  unsupported: Schema.Array(
    Schema.Struct({ resourceId: Schema.String, displayName: Schema.String, reason: Schema.String }),
  ),
}).annotate({ identifier: "MigrationTerraformResult" });

export const MigrationScenarioCreated = Schema.Struct({
  scenarioModelId: Uuid,
  name: Schema.String,
  currency: Schema.String,
  monthlyDelta: Schema.Finite,
}).annotate({ identifier: "MigrationScenarioCreated" });

export class MigrationEstimatesGroup extends HttpApiGroup.make("migrationEstimates")
  .add(
    HttpApiEndpoint.get("targets", "/targets", {
      params: OrgParams,
      success: MigrationTargets,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Providers an estimate can target")
      .annotate(
        OpenApi.Description,
        "Every provider with at least one resource type that declares a cross-provider " +
          "category, with its categories, the regions it can be priced in (with their area) and " +
          "whether pricing it needs one of the org's accounts.",
      )
      .annotate(SuccessDescription, "Providers"),
    // A read despite the method, like `/costs/query`.
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: MigrationEstimateInput,
      success: MigrationEstimateResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(InvalidRequestMessage, "Invalid migration estimate")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Compute an unsaved migration estimate")
      .annotate(
        OpenApi.Description,
        "Matches each resource to the target's type of the same category, picks the cheapest " +
          "size meeting or exceeding its vCPUs, memory and GPUs (or the override), and prices it " +
          "beside what the resource costs now. Resources with no equivalent are listed apart " +
          "with the reason. A figure nothing can price is null, never 0. A read despite the " +
          "method.",
      )
      .annotate(SuccessDescription, "The estimate"),
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(MigrationEstimate),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List saved migration estimates")
      .annotate(SuccessDescription, "Estimates, most recently changed first"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: MigrationEstimateInput,
      success: MigrationEstimate,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid migration estimate")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Save a migration estimate")
      .annotate(
        OpenApi.Description,
        "Stores the inputs only; the figures are computed on every read. Audit-logged.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: MigrationEstimate,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a saved migration estimate")
      .annotate(SuccessDescription, "The estimate's inputs"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: MigrationEstimateInput,
      success: MigrationEstimate,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid migration estimate")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Replace a migration estimate")
      .annotate(
        OpenApi.Description,
        "Name, source, target, region and overrides together. Audit-logged.",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a migration estimate")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("result", "/:id/result", {
      params: OrgIdParams,
      success: MigrationEstimateResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Compute a saved migration estimate")
      .annotate(
        OpenApi.Description,
        "The saved inputs priced now: current spend as the caller's cost visibility scope " +
          "sees it, and today's list prices.",
      )
      .annotate(SuccessDescription, "The estimate"),
    HttpApiEndpoint.get("terraform", "/:id/terraform", {
      params: OrgIdParams,
      success: MigrationTerraformResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Terraform for the target provider")
      .annotate(
        OpenApi.Description,
        "HCL for the matched rows through the target plugin's own Terraform export, with each " +
          "row's matched type, size and region. Rows the export cannot map are listed with the " +
          "reason. 400 when the target has no Terraform export.",
      )
      .annotate(SuccessDescription, "HCL"),
    HttpApiEndpoint.post("scenario", "/:id/scenario", {
      params: OrgIdParams,
      payload: MigrationScenarioInput,
      success: MigrationScenarioCreated,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid scenario")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(OpenApi.Summary, "Turn an estimate into a scenario model")
      .annotate(
        OpenApi.Description,
        "Creates a scenario model with one recurring monthly amount, the estimate's paired delta " +
          "(target minus current over the rows priced on both sides), from `startDate`. 400 when " +
          "the estimate has no single-currency delta. Audit-logged.",
      )
      .annotate(SuccessDescription, "The scenario model"),
  )
  .prefix("/api/org/:orgId/migration-estimates")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Migration estimates") {}

export class MigrationEstimatesApi extends withApiDefaults(
  HttpApi.make("migration-estimates").add(MigrationEstimatesGroup),
) {}

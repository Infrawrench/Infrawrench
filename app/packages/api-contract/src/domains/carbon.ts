/**
 * Carbon estimate: `GET /api/org/:orgId/carbon`, the endpoint definitions.
 *
 * `costs:read`, not `resources:read`: this is a figure people put beside
 * spend and into reports, grouped by account the way cost is, and shown on
 * the Costs screen. A single resource's carbon rides
 * `POST /resources/cost-estimate` (`ResourceCarbonEstimate`, still documented
 * with the resources routes), beside its price.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";

const CarbonUnestimatedReason = Schema.Literals([
  "unsupported-provider",
  "unknown-region",
  "unknown-size",
]).annotate({
  description:
    "Why a resource has no estimate. Reported per resource rather than folded into the total: " +
    "a figure that quietly excluded a third of the estate would read as a complete answer.",
});

const footprintFields = {
  vcpus: Schema.Finite.annotate({ description: "vCPUs per unit." }),
  count: Schema.Int.annotate({
    description: "Units the figure covers (node count); 1 for one machine.",
  }),
  region: Schema.String,
  grid: Schema.String.annotate({
    description:
      "The coefficient table the region resolved in: `aws`, `gcp`, `azure`, `hetzner`...",
  }),
  gridIntensity: Schema.Finite.annotate({
    description: "Grams CO2e per kWh used for this row: the published figure, not a band.",
  }),
  gridZone: Schema.String.annotate({
    description: "What the grid figure describes, e.g. `Germany`.",
  }),
  gridBasis: Schema.Literals(["ccf", "ember-2024"]).annotate({
    description:
      "`ccf`: Cloud Carbon Footprint's per-region table. `ember-2024`: Ember's 2024 lifecycle " +
      "figure for the country.",
  }),
  pue: Schema.Finite.annotate({
    description: "Datacentre overhead used: regional where published, else fleet.",
  }),
  kwh: Schema.Finite,
  kgCo2e: Schema.Finite,
};

const CarbonRow = Schema.Struct({
  ...footprintFields,
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  accountName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CarbonRow" });

const CarbonUnestimatedRow = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  accountName: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  reason: CarbonUnestimatedReason,
}).annotate({ identifier: "CarbonUnestimatedRow" });

const CarbonGroup = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kgCo2e: Schema.Finite,
  kwh: Schema.Finite,
  resourceCount: Schema.Int,
}).annotate({ identifier: "CarbonGroup" });

const CarbonAssumptions = Schema.Struct({
  cpuUtilization: Schema.Finite.annotate({
    description:
      "Assumed average CPU utilisation, 0 to 1. **The largest single source of error**, stated " +
      "here rather than buried in a constant: the product does not collect per-resource CPU " +
      "history for every provider, and a figure derived from the few that do would be " +
      "quietly inconsistent across an estate.",
  }),
  pue: Schema.Record(Schema.String, Schema.Finite).annotate({
    description: "Fleet Power Usage Effectiveness, per contributing grid.",
  }),
  vcpuWatts: Schema.Record(
    Schema.String,
    Schema.Struct({ min: Schema.Finite, max: Schema.Finite }),
  ),
  coefficientSource: Schema.String,
  coefficientVintage: Schema.String,
  scope: Schema.String.annotate({
    description: "What the estimate covers, in one sentence a reader can check.",
  }),
}).annotate({ identifier: "CarbonAssumptions" });

export const CarbonEstimate = Schema.Struct({
  windowDays: Schema.Int,
  totalKgCo2e: Schema.Finite,
  totalKwh: Schema.Finite,
  estimatedCount: Schema.Int,
  unestimated: Schema.Array(CarbonUnestimatedRow),
  unestimatedCount: Schema.Int.annotate({
    description: "Total unestimated resources; `unestimated` is capped at 200.",
  }),
  duplicateCount: Schema.Int.annotate({
    description:
      "Kubernetes nodes skipped because their machine is already counted as an instance " +
      "(a GKE node is also a GCE instance). Counted once, and the number skipped is said.",
  }),
  byRegion: Schema.Array(CarbonGroup),
  byAccount: Schema.Array(CarbonGroup),
  byProvider: Schema.Array(CarbonGroup),
  rows: Schema.Array(CarbonRow),
  assumptions: CarbonAssumptions,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "CarbonEstimate" });

export class CarbonEstimateGroup extends HttpApiGroup.make("carbon")
  .add(
    HttpApiEndpoint.get("estimate", "/", {
      params: OrgParams,
      // Read as sent: the handler answers a bad value with its own sentence.
      query: {
        windowDays: Schema.optionalKey(
          documentedAs(Schema.Int.annotate({ description: "Defaults to 30." })),
        ),
      },
      success: CarbonEstimate,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Estimated operational carbon, with its assumptions")
      .annotate(
        OpenApi.Description,
        "An **estimate**, in the same sense the cost estimates here are, and built to be honest " +
          "about that in three ways.\n\n" +
          "**A resource that cannot be placed is never guessed.** No published figure for the " +
          "provider, no entry for the region, no vCPU count: each produces an `unestimated` row " +
          "with a stated reason and contributes nothing to the total. A carbon figure computed " +
          "against a guessed grid is worse than no figure, because it is a number somebody will put " +
          "in a report.\n\n" +
          "**The assumptions travel with the answer**: utilisation, PUE, the coefficient source and " +
          "its vintage are all on the response.\n\n" +
          "**It covers processors and says so.** Virtual machines, Kubernetes nodes and sized managed " +
          "services; storage, memory, network egress and embodied (manufacturing) emissions are " +
          "excluded. Types with nothing to read (a bucket, a DNS record) are out of scope, not " +
          "unestimated.\n\n" +
          "What to read comes from each plugin's `carbon` declaration (or its `rightsizing` one): the " +
          "region field, and vCPUs either directly or through the create form's size catalogue. " +
          "Managed clusters whose nodes are listed in their own right are left out of the total, and " +
          "a Kubernetes node that is also an instance is counted once (`duplicateCount`).\n\n" +
          "Grid figures are Cloud Carbon Footprint's (Apache-2.0) for AWS, GCP and Azure, and Ember's " +
          "2024 country figures for every other provider; each row says which (`gridBasis`). They " +
          "are not measured by us. One resource's monthly figure rides " +
          "`POST /resources/cost-estimate` as `carbon`, beside its price.",
      )
      .annotate(SuccessDescription, "The estimate")
      .annotate(
        OpenApi.Transform,
        numericQuery({ windowDays: { type: "integer", minimum: 1, maximum: 365 } }),
      ),
  )
  .prefix("/api/org/:orgId/carbon")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Carbon") {}

export class CarbonApi extends withApiDefaults(HttpApi.make("carbon").add(CarbonEstimateGroup)) {}

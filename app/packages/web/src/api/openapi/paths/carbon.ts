import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const CarbonUnestimatedReason = z
  .enum(["unsupported-provider", "unknown-region", "unknown-size"])
  .openapi({
    description:
      "Why a resource has no estimate. Reported per resource rather than folded into the total: " +
      "a figure that quietly excluded a third of the estate would read as a complete answer.",
  });

const footprintShape = {
  vcpus: z.number().describe("vCPUs per unit."),
  count: z.number().int().describe("Units the figure covers (node count); 1 for one machine."),
  region: z.string(),
  grid: z
    .string()
    .describe("The coefficient table the region resolved in: `aws`, `gcp`, `azure`, `hetzner`..."),
  gridIntensity: z
    .number()
    .describe("Grams CO2e per kWh used for this row: the published figure, not a band."),
  gridZone: z.string().describe("What the grid figure describes, e.g. `Germany`."),
  gridBasis: z
    .enum(["ccf", "ember-2024"])
    .describe(
      "`ccf`: Cloud Carbon Footprint's per-region table. `ember-2024`: Ember's 2024 lifecycle " +
        "figure for the country.",
    ),
  pue: z.number().describe("Datacentre overhead used: regional where published, else fleet."),
  kwh: z.number(),
  kgCo2e: z.number(),
};

export const CarbonFootprint = strict(footprintShape).openapi("CarbonFootprint");

const CarbonRow = strict({
  ...footprintShape,
  resourceId: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  accountName: z.string().nullable(),
}).openapi("CarbonRow");

const CarbonUnestimatedRow = strict({
  resourceId: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  accountName: z.string().nullable(),
  region: z.string().nullable(),
  reason: CarbonUnestimatedReason,
}).openapi("CarbonUnestimatedRow");

const CarbonGroup = strict({
  key: z.string(),
  label: z.string(),
  kgCo2e: z.number(),
  kwh: z.number(),
  resourceCount: z.number().int(),
}).openapi("CarbonGroup");

const CarbonAssumptions = strict({
  cpuUtilization: z
    .number()
    .describe(
      "Assumed average CPU utilisation, 0 to 1. **The largest single source of error**, stated " +
        "here rather than buried in a constant: the product does not collect per-resource CPU " +
        "history for every provider, and a figure derived from the few that do would be " +
        "quietly inconsistent across an estate.",
    ),
  pue: z
    .record(z.string(), z.number())
    .describe("Fleet Power Usage Effectiveness, per contributing grid."),
  vcpuWatts: z.record(z.string(), strict({ min: z.number(), max: z.number() })),
  coefficientSource: z.string(),
  coefficientVintage: z.string(),
  scope: z.string().describe("What the estimate covers, in one sentence a reader can check."),
}).openapi("CarbonAssumptions");

const CarbonEstimate = strict({
  windowDays: z.number().int(),
  totalKgCo2e: z.number(),
  totalKwh: z.number(),
  estimatedCount: z.number().int(),
  unestimated: z.array(CarbonUnestimatedRow),
  unestimatedCount: z
    .number()
    .int()
    .describe("Total unestimated resources; `unestimated` is capped at 200."),
  duplicateCount: z
    .number()
    .int()
    .describe(
      "Kubernetes nodes skipped because their machine is already counted as an instance " +
        "(a GKE node is also a GCE instance). Counted once, and the number skipped is said.",
    ),
  byRegion: z.array(CarbonGroup),
  byAccount: z.array(CarbonGroup),
  byProvider: z.array(CarbonGroup),
  rows: z.array(CarbonRow),
  assumptions: CarbonAssumptions,
  generatedAt: IsoDateTime,
}).openapi("CarbonEstimate");

export const ResourceCarbonEstimate = strict({
  estimate: CarbonFootprint.nullable().describe("Monthly (730 h) footprint, or null."),
  reason: CarbonUnestimatedReason.nullable().describe(
    "Why there is no estimate. Null when there is one, or when the type is out of scope.",
  ),
  inScope: z
    .boolean()
    .describe("False when the type declares nothing to read: a bucket, a DNS record."),
  role: z
    .enum(["instance", "aggregate"])
    .describe(
      "`aggregate`: a group (a managed cluster) whose machines are also listed in their own " +
        "right; shown per resource, never summed into the org total.",
    ),
  assumptions: CarbonAssumptions.pick({
    cpuUtilization: true,
    coefficientSource: true,
    coefficientVintage: true,
    scope: true,
  }),
}).openapi("ResourceCarbonEstimate");

export function registerCarbonPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/carbon",
    tags: ["Carbon"],
    summary: "Estimated operational carbon, with its assumptions",
    description:
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
    request: {
      params: OrgIdParam,
      query: z.object({
        windowDays: z.coerce.number().int().min(1).max(365).optional().describe("Defaults to 30."),
      }),
    },
    responses: {
      200: {
        description: "The estimate",
        content: { "application/json": { schema: CarbonEstimate } },
      },
      400: ErrorResponses[400],
    },
  });
}

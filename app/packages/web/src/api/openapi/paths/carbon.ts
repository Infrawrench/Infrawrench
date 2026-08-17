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

export function registerCarbonPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const CarbonRow = strict({
    resourceId: z.string(),
    displayName: z.string(),
    pluginId: z.string(),
    accountId: Uuid,
    accountName: z.string().nullable(),
    region: z.string().nullable(),
    vcpus: z.number(),
    gridIntensity: z
      .number()
      .describe("Grams CO2e per kWh used for this row — the published figure, not a band."),
    kwh: z.number(),
    kgCo2e: z.number(),
  }).openapi("CarbonRow");

  const CarbonUnestimatedRow = strict({
    resourceId: z.string(),
    displayName: z.string(),
    pluginId: z.string(),
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
        "Assumed average CPU utilisation, 0–1. **The largest single source of error**, stated " +
          "here rather than buried in a constant: the product does not collect per-resource CPU " +
          "history for every provider, and a figure derived from the few that do would be " +
          "quietly inconsistent across an estate.",
      ),
    pue: z
      .record(z.string(), z.number())
      .describe("Power Usage Effectiveness, per contributing provider."),
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
    byRegion: z.array(CarbonGroup),
    byAccount: z.array(CarbonGroup),
    rows: z.array(CarbonRow),
    assumptions: CarbonAssumptions,
    generatedAt: IsoDateTime,
  }).openapi("CarbonEstimate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/carbon",
    tags: ["Carbon"],
    summary: "Estimated operational carbon, with its assumptions",
    description:
      "An **estimate**, in the same sense the cost estimates here are, and built to be honest " +
      "about that in three ways.\n\n" +
      "**A resource that cannot be placed is never guessed.** No published figure for the " +
      "provider, no entry for the region, no vCPU count — each produces an `unestimated` row " +
      "with a stated reason and contributes nothing to the total. A carbon figure computed " +
      "against a guessed grid is worse than no figure, because it is a number somebody will put " +
      "in a report.\n\n" +
      "**The assumptions travel with the answer**: utilisation, PUE, the coefficient source and " +
      "its vintage are all on the response.\n\n" +
      "**It covers operational compute and says so.** Storage, network egress, managed services " +
      "and embodied (manufacturing) emissions are excluded.\n\n" +
      "vCPU counts come from each plugin's own size catalogue via the `rightsizing` declaration, " +
      "so a provider that gains right-sizing gains a carbon estimate for free — and a type that " +
      "declares no size field is an explainable gap rather than a guess.\n\n" +
      "Coefficients are reproduced from the Cloud Carbon Footprint project (Apache-2.0), which " +
      "sources them from government and grid-operator publications. They are not measured by us.",
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

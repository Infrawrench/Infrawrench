import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerRightsizingPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const OversizedSizeSummary = strict({
    id: z.string().openapi({ example: "cx32" }),
    label: z.string(),
    vcpus: z.number().int(),
    memoryMb: z.number().int(),
    priceMonthly: z
      .number()
      .nullable()
      .describe("Monthly catalog price in `currency`; null when unpriced."),
  }).openapi("OversizedSizeSummary");

  const OversizedResource = strict({
    id: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "Server" }),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    sizeFieldKey: z
      .string()
      .describe(
        "Field to submit through the resource-update endpoint to apply the recommended size.",
      )
      .openapi({ example: "serverType" }),
    region: z.string().nullable().describe("Provider region/zone/location the resource lives in."),
    currentSize: OversizedSizeSummary,
    recommendedSize: OversizedSizeSummary,
    cpuP95: z
      .number()
      .describe("p95 CPU utilisation over the window, percent of the current size."),
    memoryP95: z
      .number()
      .nullable()
      .describe("p95 memory utilisation, percent of the current size; null when unmeasured."),
    memoryMeasured: z
      .boolean()
      .describe("False when the provider stores no memory series for this resource."),
    projectedCpuP95: z
      .number()
      .describe("Projected p95 CPU on the recommended size, for the confirm dialog."),
    currency: z.string().describe("ISO 4217 code the size prices are quoted in.").openapi({
      example: "USD",
    }),
    monthlySaving: z
      .number()
      .nullable()
      .describe("Current minus recommended monthly price; null when either side is unpriced."),
    resizeNote: z
      .string()
      .nullable()
      .describe("Plugin-authored caveat (e.g. the provider requires the machine stopped)."),
    lastSyncedAt: IsoDateTime.nullable(),
  }).openapi("OversizedResource");

  const OversizedAccountGroup = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "Hetzner" }),
    resources: z.array(OversizedResource),
  }).openapi("OversizedAccountGroup");

  const RightsizingListResponse = strict({
    accounts: z.array(OversizedAccountGroup).describe("Groups sorted by account name."),
    totalCount: z.number().int(),
    windowDays: z.number().int().describe("Days of stored metrics the percentiles cover."),
    generatedAt: IsoDateTime,
  }).openapi("RightsizingListResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/rightsizing",
    tags: ["Orphans"],
    summary: "List oversized resources with resize recommendations",
    description:
      "Computes p95 CPU/memory utilisation over the last 14 days of stored metrics for every " +
      "resource whose plugin declares right-sizing support, and matches under-utilised ones " +
      "against the plugin's real size catalog (the create form's size options, live-priced). " +
      "Each recommendation names the cheapest smaller size that still clears a headroom margin " +
      "and quotes the monthly saving. Apply one by submitting `sizeFieldKey` with the " +
      "recommended size id through the resource-update endpoint — which enforces change " +
      "freezes and writes the audit trail. Results are cached for a few minutes; pass " +
      "`refresh=true` to recompute.",
    request: {
      params: OrgIdParam,
      query: strict({
        refresh: z
          .enum(["true", "false"])
          .optional()
          .describe("Bypass the short server-side cache and recompute now."),
      }),
    },
    responses: {
      200: {
        description: "Oversized resources grouped by account",
        content: { "application/json": { schema: RightsizingListResponse } },
      },
    },
  });
}

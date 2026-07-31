import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerOrphanPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const OrphanCostAnnotation = strict({
    amount: z.number().describe("Spend over the trailing cost window."),
    currency: z.string().openapi({ example: "USD" }),
  }).openapi("OrphanCostAnnotation");

  const OrphanedResource = strict({
    id: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "EBS Volume" }),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    reason: z
      .string()
      .describe("Plugin-authored explanation of why this resource looks wasted.")
      .openapi({ example: "Volume is not attached to any Droplet" }),
    cost: OrphanCostAnnotation.nullable().describe(
      "Best-effort trailing spend matched from collected per-resource cost rows; " +
        "null when the provider reports no per-resource cost. The flag itself never " +
        "depends on billing data.",
    ),
    lastSyncedAt: IsoDateTime.nullable(),
  }).openapi("OrphanedResource");

  const OrphanAccountGroup = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "DigitalOcean" }),
    resources: z.array(OrphanedResource),
  }).openapi("OrphanAccountGroup");

  const OrphanListResponse = strict({
    accounts: z.array(OrphanAccountGroup).describe("Groups sorted by account name."),
    totalCount: z.number().int(),
    costWindowDays: z.number().int().describe("Days of trailing spend the annotations cover."),
    generatedAt: IsoDateTime,
  }).openapi("OrphanListResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/orphans",
    tags: ["Orphans"],
    summary: "List likely-orphaned and idle resources",
    description:
      "Scans the organization's already-synced resources against each plugin's declarative " +
      "orphan heuristics — unattached volumes, unassigned floating/elastic IPs, reserved-but-" +
      "unused static IPs — and returns the matches grouped by account, each with the plugin's " +
      "reason. Purely a read over stored state: no provider API calls are made, so results " +
      "reflect the last sync. Where the org's collected cost data has per-resource rows, " +
      "matches are annotated with trailing spend.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Flagged resources grouped by account",
        content: { "application/json": { schema: OrphanListResponse } },
      },
    },
  });
}

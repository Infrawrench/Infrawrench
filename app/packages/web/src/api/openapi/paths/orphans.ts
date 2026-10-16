import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime, FindingRemediation } from "../common";
import type { BuildContext } from "../context";

export function registerOrphanPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const OrphanCostAnnotation = strict({
    amount: z.number().describe("Spend over the trailing cost window."),
    currency: z.string().openapi({ example: "USD" }),
  }).openapi("OrphanCostAnnotation");

  // Shared with the ownership paths, which register it. Declared here too
  // because the orphan response is the surface most clients meet it on.
  const ResourceOwnerAnnotation = strict({
    userId: Uuid.nullable().describe("Set when a routable org member owns it."),
    displayName: z.string().describe("The member's name, or the free-text owner."),
    isLabel: z.boolean().describe("True when the owner is free text; nothing can be routed to it."),
    ticketUrl: z.string().nullable(),
    purpose: z.string().nullable(),
  }).openapi("ResourceOwnerAnnotation");

  const IdleMetricEvidence = strict({
    metric: z
      .string()
      .describe("Provider metric name.")
      .openapi({ example: "BytesOutToDestination" }),
    label: z.string().openapi({ example: "Bytes sent to the internet" }),
    statistic: z.enum(["sum", "max", "average", "min", "count"]),
    value: z
      .number()
      .nullable()
      .describe(
        "The aggregate over the whole lookback window; null when the provider had no data.",
      ),
    unit: z.enum(["count", "bytes", "percent", "days"]),
    threshold: z
      .number()
      .nullable()
      .optional()
      .describe("The bound this reading was judged against, when it was a deciding reading."),
    comparison: z
      .enum(["atMost", "atLeast"])
      .optional()
      .describe("`atMost`: the value at or under the threshold is the idle side."),
  }).openapi("IdleMetricEvidence");

  const IdleSavingsEstimate = strict({
    monthlyAmount: z.number().describe("Monthly figure at the provider's published rate."),
    currency: z.string().openapi({ example: "USD" }),
    basis: z.enum(["list-price"]),
    note: z.string().optional().describe("Caveat shown beside the figure."),
  }).openapi("IdleSavingsEstimate");

  const OrphanIdleDetail = strict({
    ruleId: z.string().openapi({ example: "nat-gateway" }),
    ruleKey: z.string().describe("`pluginId:ruleId`, the key the settings use.").openapi({
      example: "aws:nat-gateway",
    }),
    ruleLabel: z.string().openapi({ example: "Idle NAT gateway" }),
    action: z
      .enum(["remove", "reconfigure", "stop"])
      .describe(
        "What acting on it means. Only `remove` findings are offered as a removal pull request.",
      ),
    lookbackDays: z.number().int(),
    evidence: z.array(IdleMetricEvidence),
    detectedAt: IsoDateTime.describe("First collection that flagged it."),
    evaluatedAt: IsoDateTime.describe("Latest collection that confirmed it."),
    hasResource: z
      .boolean()
      .describe(
        "False when the subject is not a synced resource (a custom metric): `id` is then a " +
          "finding id, not a resource id.",
      ),
  }).openapi("OrphanIdleDetail");

  const OrphanedResource = strict({
    id: z
      .string()
      .describe(
        "Infrawrench resource id; for an idle finding whose `idle.hasResource` is false, a " +
          "finding id prefixed `idle:`.",
      ),
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
    owner: ResourceOwnerAnnotation.nullable().describe(
      "Who owns this resource, or null when nobody has claimed it. Present only " +
        "when the owner can be named: a resource carrying a purpose but no owner " +
        "reads as null, because the question this answers is who to tell.",
    ),
    lastSyncedAt: IsoDateTime.nullable(),
    remediation: FindingRemediation.optional().describe(
      "Ready-to-run commands to clean this resource up (snapshot first where it applies).",
    ),
    idle: OrphanIdleDetail.optional().describe(
      "Present when a metric-based idle rule flagged the row rather than the type's " +
        "orphan rule: the rule, the metric evidence and the lookback window.",
    ),
    estimate: IdleSavingsEstimate.nullable()
      .optional()
      .describe(
        "Monthly figure at the provider's published list price, for idle rows a plugin could " +
          "price. An estimate: show it only when `cost` (billed spend) is null.",
      ),
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
    unownedCount: z
      .number()
      .int()
      .describe("Flagged resources with no recorded owner; the 'nobody to ask' count."),
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
      "orphan heuristics (unattached volumes, unassigned floating/elastic IPs, reserved-but-" +
      "unused static IPs) and returns the matches grouped by account, each with the plugin's " +
      "reason. Rows flagged by a metric-based idle rule (a NAT gateway with no traffic, a load " +
      "balancer with no requests) carry `idle` with the evidence; those verdicts come from a " +
      "daily collection, tuned under `/idle-findings`. Purely a read over stored state: no " +
      "provider API calls are made. Where the org's collected cost data has per-resource rows, " +
      "matches are annotated with trailing spend; idle rows a plugin could price also carry a " +
      "list-price `estimate`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Flagged resources grouped by account",
        content: { "application/json": { schema: OrphanListResponse } },
      },
    },
  });
}

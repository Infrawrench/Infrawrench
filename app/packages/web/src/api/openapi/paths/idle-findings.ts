import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerIdleFindingPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const IdleRuleOverride = strict({
    enabled: z.boolean().optional().describe("False switches the rule off for the organization."),
    thresholds: z
      .record(z.string(), z.number())
      .optional()
      .describe("Threshold overrides by key; each must sit within the rule's declared range."),
  }).openapi("IdleRuleOverride");

  const IdleFindingSettings = strict({
    enabled: z.boolean().describe("Master switch: off stops collection and hides every idle row."),
    lookbackDays: z
      .number()
      .int()
      .min(7)
      .max(42)
      .describe("Days of metrics each rule judges over, 7 to 42. Ships as 14."),
    rules: z
      .record(z.string(), IdleRuleOverride)
      .describe(
        "Overrides keyed by `pluginId:ruleId`. A rule absent here runs enabled with its declared " +
          "defaults.",
      ),
  }).openapi("IdleFindingSettings");

  const IdleFindingSettingsUpdate = strict({
    enabled: z.boolean().optional(),
    lookbackDays: z.number().int().min(7).max(42).optional(),
    rules: z
      .record(z.string(), IdleRuleOverride)
      .optional()
      .describe("Replaces the whole overrides map when sent."),
  }).openapi("IdleFindingSettingsUpdate");

  const IdleRuleThresholdView = strict({
    key: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    unit: z.enum(["count", "bytes", "percent", "days"]),
    default: z.number(),
    min: z.number(),
    max: z.number(),
    value: z.number().describe("The effective value after the organization's override."),
  }).openapi("IdleRuleThresholdView");

  const IdleRuleView = strict({
    ruleKey: z.string().openapi({ example: "aws:nat-gateway" }),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    ruleId: z.string(),
    label: z.string().openapi({ example: "Idle NAT gateway" }),
    description: z.string(),
    action: z.enum(["remove", "reconfigure", "stop"]),
    resourceTypeNames: z.array(z.string()),
    enabled: z.boolean(),
    thresholds: z.array(IdleRuleThresholdView),
  }).openapi("IdleRuleView");

  const IdleAccountStatus = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    lastPolledAt: IsoDateTime.nullable(),
    nextPollAt: IsoDateTime.nullable(),
    lastError: z.string().nullable().describe("Last collection failure; null after a success."),
    helpLabel: z.string().nullable(),
    helpUrl: z.string().nullable().describe("https link to the fix for a permission gap."),
    findingCount: z.number().int(),
  }).openapi("IdleAccountStatus");

  const IdleFindingsOverview = strict({
    settings: IdleFindingSettings,
    rules: z.array(IdleRuleView),
    accounts: z.array(IdleAccountStatus),
  }).openapi("IdleFindingsOverview");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/idle-findings",
    tags: ["Orphans"],
    summary: "Idle rules, their settings and collection status",
    description:
      "Every metric-based idle rule the loaded plugins declare (idle NAT gateways, load " +
      "balancers, caches, provisioned tables, clusters, unused custom metrics), with the " +
      "organization's effective thresholds, plus each account's last collection and error. " +
      "The findings themselves are rows of `GET /orphans` with `idle` set.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Settings, rule catalog and per-account status",
        content: { "application/json": { schema: IdleFindingsOverview } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/idle-findings/settings",
    tags: ["Orphans"],
    summary: "Get the organization's idle-rule settings",
    description: "An organization that never saved reads the shipped defaults (enabled, 14 days).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Idle-rule settings",
        content: { "application/json": { schema: IdleFindingSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/idle-findings/settings",
    tags: ["Orphans"],
    summary: "Update the idle-rule settings",
    description:
      "Every field is optional. `lookbackDays` must be a whole number from 7 to 42; an unknown " +
      "rule or threshold key, or a threshold outside its declared range, is rejected rather " +
      "than clamped. Any change makes every account due for a fresh collection.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: IdleFindingSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: IdleFindingSettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/idle-findings/rescan",
    tags: ["Orphans"],
    summary: "Re-scan idle rules now",
    description:
      "Makes every account due for an idle collection on the next poller tick. The reads are " +
      "billed to the organization's own cloud accounts (CloudWatch GetMetricData and the like).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Scheduled",
        content: { "application/json": { schema: strict({ ok: z.literal(true) }) } },
      },
    },
  });
}

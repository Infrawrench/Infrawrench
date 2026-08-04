import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const PostureSeverity = z.enum(["critical", "high", "medium", "low"]).openapi({
  description:
    "How bad the finding is. `critical` and `high` findings feed the posture alerts; " +
    "`medium` and `low` are hygiene work surfaced on the posture screen only.",
});

const PostureCategory = z
  .enum(["public-exposure", "encryption", "credential-age", "data-protection", "other"])
  .openapi({ description: "Grouping bucket for what kind of exposure the finding describes." });

export function registerPosturePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const PostureFinding = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "AWS" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "S3 Bucket" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    ruleId: z
      .string()
      .describe("The matched rule's stable id, unique within the plugin.")
      .openapi({ example: "hetzner-server-no-firewall" }),
    title: z.string().describe("Short rule title.").openapi({ example: "No firewall attached" }),
    severity: PostureSeverity,
    category: PostureCategory,
    reason: z.string().describe("Plugin-authored explanation of why this is a finding."),
  }).openapi("PostureFinding");

  const PostureSeverityCounts = strict({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }).openapi("PostureSeverityCounts");

  const PostureListResponse = strict({
    findings: z.array(PostureFinding).describe("All findings, worst severity first."),
    totalCount: z.number().int(),
    counts: PostureSeverityCounts.describe(
      "Finding count per severity; every bucket present, zeros included.",
    ),
    generatedAt: IsoDateTime,
  }).openapi("PostureListResponse");

  const PostureSettings = strict({
    enabled: z.boolean().openapi({
      description: "Whether the poller sends posture alerts for this organization at all.",
    }),
    lastNotifiedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({
        description:
          "When the organization's posture alert scan last completed, or null before the " +
          "first. Owned by the poller's cooldown claim; not writable through this API.",
      }),
  }).openapi("PostureAlertSettings");

  const PostureSettingsUpdate = strict({
    enabled: z.boolean().optional(),
  }).openapi("PostureAlertSettingsUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/posture",
    tags: ["Posture checks"],
    summary: "List security posture findings on synced resources",
    description:
      "Plugin-declared security checks evaluated over already-synced resource state: public " +
      "buckets, 0.0.0.0/0 ingress rules, unencrypted disks, publicly reachable database " +
      "endpoints, stale credentials, missing deletion/backup protection. No provider API " +
      "calls are made and results reflect the last sync. Findings are sorted worst severity " +
      "first, with per-severity counts.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Posture findings, worst first",
        content: { "application/json": { schema: PostureListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/posture/settings",
    tags: ["Posture checks"],
    summary: "Get the organization's posture alert settings",
    description:
      "Whether the poller's daily posture alert scan is enabled. An organization that never " +
      "saved reads the shipped defaults (enabled).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Posture alert settings",
        content: { "application/json": { schema: PostureSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/posture/settings",
    tags: ["Posture checks"],
    summary: "Update the posture alert settings",
    description: "Saving never resets the alert cooldown.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PostureSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: PostureSettings } },
      },
      400: ErrorResponses[400],
    },
  });
}

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

  // Kept as a raw shape so `DismissedPostureFinding` can be emitted as one
  // flat object rather than an `allOf` branch. A branch that declares only
  // `dismissal` while inheriting the rest through a sibling `$ref` is
  // uninhabited under `additionalProperties: false` — JSON Schema evaluates
  // that keyword against the properties in the same object, so every inherited
  // field reads as unexpected and strict validators reject real payloads.
  const postureFindingShape = {
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
  } as const;

  const PostureFinding = strict(postureFindingShape).openapi("PostureFinding");

  const PostureSeverityCounts = strict({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }).openapi("PostureSeverityCounts");

  const PostureDismissal = strict({
    resourceId: z.string(),
    ruleId: z.string(),
    dismissedAt: IsoDateTime.describe("When the finding was accepted."),
    dismissedBy: z
      .string()
      .nullable()
      .describe("Display name or email of whoever accepted it; null when unknown."),
    reason: z.string().nullable().describe("The operator's note, when they left one."),
  }).openapi("PostureDismissal");

  const DismissedPostureFinding = strict({
    ...postureFindingShape,
    dismissal: PostureDismissal,
  }).openapi("DismissedPostureFinding");

  const PostureListResponse = strict({
    findings: z
      .array(PostureFinding)
      .describe("Live findings, worst severity first. Dismissed findings are not included."),
    totalCount: z.number().int().describe("Live finding count; dismissals excluded."),
    counts: PostureSeverityCounts.describe(
      "Live finding count per severity; every bucket present, zeros included.",
    ),
    dismissed: z
      .array(DismissedPostureFinding)
      .describe(
        "Findings a dismissal is currently suppressing, most recently dismissed first. " +
          "Only dismissals whose rule still matches appear, so a finding that has since " +
          "been fixed simply drops out.",
      ),
    dismissedCount: z.number().int(),
    generatedAt: IsoDateTime,
  }).openapi("PostureListResponse");

  const PostureDismissalCreate = strict({
    resourceId: z.string().describe("Infrawrench resource id the finding is on."),
    ruleId: z.string().describe("The matched rule's id."),
    reason: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Why this finding is acceptable. Trimmed; an empty note is stored as none."),
  }).openapi("PostureDismissalCreate");

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
      "first, with per-severity counts. Findings the organization has dismissed are reported " +
      "separately under `dismissed` and are excluded from `findings`, `counts` and the " +
      "posture alerts.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Posture findings, worst first",
        content: { "application/json": { schema: PostureListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/posture/dismissals",
    tags: ["Posture checks"],
    summary: "Dismiss a posture finding",
    description:
      "Accept a finding — the bucket really is meant to be public, the key really is rotated " +
      "out of band. The finding leaves `findings` and stops feeding the daily posture alerts, " +
      "but the rule keeps being evaluated and the finding is reported back under `dismissed` " +
      "for as long as it still matches. Idempotent: dismissing an already-dismissed finding " +
      "rewrites the note and the author.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PostureDismissalCreate } } },
    },
    responses: {
      200: {
        description: "The recorded dismissal",
        content: { "application/json": { schema: PostureDismissal } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/posture/dismissals",
    tags: ["Posture checks"],
    summary: "Restore a dismissed posture finding",
    description:
      "Undo a dismissal, putting the finding back on the list and back into the alert feed. " +
      "The finding is identified by query parameters rather than path segments because " +
      "resource ids are provider-native and routinely contain slashes.",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: z.string().describe("Infrawrench resource id the finding is on."),
        ruleId: z.string().describe("The matched rule's id."),
      }),
    },
    responses: {
      204: { description: "The dismissal was removed" },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
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

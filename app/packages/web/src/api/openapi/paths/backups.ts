import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const BackupSeverity = z.enum(["critical", "high", "medium", "low"]).openapi({
  description: "How bad the gap is. Orphaned backups are always `low` — they cost money, not data.",
});

const BackupFindingKind = z
  .enum(["unprotected", "rpo-breach", "retention-below-policy", "orphaned-snapshot"])
  .openapi({
    description:
      "What the finding describes: nothing protects the resource; the newest backup is older " +
      "than the policy's RPO; the provider-native retention window is shorter than the policy " +
      "asks; or a backup whose source resource no longer exists.",
  });

const BackupProtectionState = z
  .enum(["protected", "automated", "stale", "unknown", "unprotected"])
  .openapi({
    description:
      "How the resource reads at a glance. `automated` means the provider is taking backups we " +
      "cannot enumerate, so there is a restore point but no listable one. `unknown` means the " +
      "resource type declares a provider-native automated-backup signal but this instance's " +
      "value could not be read — it is unassessed, not a confirmed gap, and never produces a " +
      "finding.",
  });

export function registerBackupPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const BackupFinding = strict({
    resourceId: z.string().describe("Infrawrench resource id the finding is on."),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "DigitalOcean" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "Volume" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    kind: BackupFindingKind,
    severity: BackupSeverity,
    title: z.string().openapi({ example: "No backup of this volume" }),
    detail: z.string().describe("Sentence explaining the gap and what would close it."),
    policyId: Uuid.nullable().describe(
      "The policy supplying the objective this finding breaches — the RPO policy for " +
        "`rpo-breach`, the retention policy for `retention-below-policy`. Null when no policy " +
        "applies.",
    ),
    policyName: z.string().nullable(),
    rpoHours: z
      .number()
      .nullable()
      .describe("Hours since the newest backup protecting the resource; null when there is none."),
    maxRpoHours: z.number().int().nullable().describe("The policy's allowance, when one applied."),
    retentionDays: z
      .number()
      .nullable()
      .describe("Provider-native retention window in days, when the plugin syncs one."),
    minRetentionDays: z.number().int().nullable(),
    latestBackupId: z.string().nullable(),
    latestBackupName: z.string().nullable(),
    latestBackupAt: IsoDateTime.nullable(),
    sizeGb: z
      .number()
      .nullable()
      .describe("Size of an orphaned backup in GiB, when the plugin syncs one."),
    monthlyCost: z
      .number()
      .nullable()
      .describe(
        "Trailing-30-day spend on an orphaned backup. Null means the cost could not be " +
          "determined — never that the backup is free.",
      ),
    currency: z.string().nullable(),
  }).openapi("BackupFinding");

  const BackupCoverageRow = strict({
    resourceId: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable(),
    state: BackupProtectionState,
    backupCount: z.number().int().describe("Backups in the inventory that protect this resource."),
    latestBackupId: z.string().nullable(),
    latestBackupName: z.string().nullable(),
    latestBackupAt: IsoDateTime.nullable(),
    rpoHours: z.number().nullable(),
    automatedBackups: z
      .boolean()
      .nullable()
      .describe(
        "Whether provider-native automated backups are on. Null means the plugin syncs no " +
          "signal either way — which never counts as protection and never counts as a fault.",
      ),
    retentionDays: z.number().nullable(),
    rpoPolicyId: Uuid.nullable().describe(
      "The policy supplying `maxRpoHours` — the strictest RPO among those selecting this " +
        "resource. Tracked separately from the retention policy because the two strictest " +
        "demands routinely come from different policies.",
    ),
    rpoPolicyName: z.string().nullable(),
    retentionPolicyId: Uuid.nullable().describe("The policy supplying `minRetentionDays`."),
    retentionPolicyName: z.string().nullable(),
    maxRpoHours: z.number().int().nullable(),
    minRetentionDays: z.number().int().nullable(),
  }).openapi("BackupCoverageRow");

  const BackupSeverityCounts = strict({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }).openapi("BackupSeverityCounts");

  const BackupKindCounts = strict({
    unprotected: z.number().int(),
    "rpo-breach": z.number().int(),
    "retention-below-policy": z.number().int(),
    "orphaned-snapshot": z.number().int(),
  }).openapi("BackupKindCounts");

  const BackupCoverageSummary = strict({
    statefulCount: z
      .number()
      .int()
      .describe("Stateful resources the plugin declarations can judge."),
    protectedCount: z.number().int(),
    unprotectedCount: z
      .number()
      .int()
      .describe("Confirmed gaps. Excludes unassessed resources; this is what the digest counts."),
    unknownCount: z
      .number()
      .int()
      .describe(
        "Resources that could not be assessed: the type declares a provider-native " +
          "automated-backup signal but this instance's value was absent or unrecognised. " +
          "Reported separately so 'we found no gap' and 'we could not tell' do not read alike.",
      ),
    backupCount: z.number().int(),
    orphanedBackupCount: z.number().int(),
    unattributableBackupCount: z
      .number()
      .int()
      .describe(
        "Backups whose source could not be determined — the plugin syncs no source field, the " +
          "field was empty, or more than one resource answered to it. Reported rather than " +
          "hidden: 'we found no orphans' and 'we could not tell' are different answers.",
      ),
    orphanedGb: z.number().nullable(),
    orphanedMonthlyCost: z
      .number()
      .nullable()
      .describe("Null when billing data is unavailable or the orphans span several currencies."),
    currency: z.string().nullable(),
    worstRpoHours: z
      .number()
      .nullable()
      .describe("Largest RPO across resources that have a datable backup at all."),
  }).openapi("BackupCoverageSummary");

  const BackupCoverageResponse = strict({
    findings: z.array(BackupFinding).describe("Gaps, worst severity first."),
    counts: BackupSeverityCounts,
    kindCounts: BackupKindCounts,
    totalCount: z.number().int(),
    resources: z.array(BackupCoverageRow),
    summary: BackupCoverageSummary,
    generatedAt: IsoDateTime,
  }).openapi("BackupCoverageResponse");

  const BackupPolicy = strict({
    id: Uuid,
    name: z.string(),
    resourceTypeIds: z
      .array(z.string())
      .describe("Resource types the policy selects; empty selects every stateful type."),
    tagKey: z
      .string()
      .nullable()
      .describe("Tag key that must be present. Matched case-insensitively."),
    tagValue: z
      .string()
      .nullable()
      .describe("Required value of `tagKey`, matched exactly. Null means presence is enough."),
    maxRpoHours: z
      .number()
      .int()
      .nullable()
      .describe("The newest backup must be no older than this. Null means no RPO demand."),
    minRetentionDays: z
      .number()
      .int()
      .nullable()
      .describe("Provider-native retention must be at least this. Null means no demand."),
    enabled: z.boolean(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("BackupPolicy");

  const BackupPolicyList = strict({ policies: z.array(BackupPolicy) }).openapi("BackupPolicyList");

  const BackupPolicyCreate = strict({
    name: z.string().min(1).max(120),
    resourceTypeIds: z.array(z.string()).max(100).optional(),
    tagKey: z.string().max(128).nullable().optional(),
    tagValue: z.string().max(256).nullable().optional(),
    maxRpoHours: z.number().int().min(1).max(8760).nullable().optional(),
    minRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    enabled: z.boolean().optional(),
  }).openapi("BackupPolicyCreate");

  const BackupPolicyUpdate = strict({
    name: z.string().min(1).max(120).optional(),
    resourceTypeIds: z.array(z.string()).max(100).optional(),
    tagKey: z.string().max(128).nullable().optional(),
    tagValue: z.string().max(256).nullable().optional(),
    maxRpoHours: z.number().int().min(1).max(8760).nullable().optional(),
    minRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    enabled: z.boolean().optional(),
  }).openapi("BackupPolicyUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/backups",
    tags: ["Backup coverage"],
    summary: "List backup coverage across synced resources",
    description:
      "What protects the organization's stateful resources, what does not, and which backups " +
      "protect nothing. Derived from already-synced inventory using the `backupRole` and " +
      "`backupPolicy` declarations plugins carry on their resource types — no provider API " +
      "calls are made and results reflect the last sync. Findings are recomputed on every " +
      "read rather than stored. Orphaned backups carry a trailing-30-day spend quote when " +
      "billing data is available.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Backup coverage, worst findings first",
        content: { "application/json": { schema: BackupCoverageResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/backups/policies",
    tags: ["Backup coverage"],
    summary: "List the organization's backup policies",
    description:
      "The recovery objectives coverage is judged against. A policy selects resources by type " +
      "and/or tag and demands a maximum RPO, a minimum retention, or both.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's backup policies, newest first",
        content: { "application/json": { schema: BackupPolicyList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/backups/policies",
    tags: ["Backup coverage"],
    summary: "Create a backup policy",
    description:
      "A policy must demand at least one of `maxRpoHours` and `minRetentionDays` — one that " +
      "demands nothing could never produce a finding and would read as protection while " +
      "providing none. An empty `resourceTypeIds` selects every stateful resource type.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: BackupPolicyCreate } } },
    },
    responses: {
      200: {
        description: "The created policy",
        content: { "application/json": { schema: BackupPolicy } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/backups/policies/{policyId}",
    tags: ["Backup coverage"],
    summary: "Update a backup policy",
    description:
      "Omitted fields are left alone; an explicit `null` clears `tagKey`, `tagValue`, " +
      "`maxRpoHours` or `minRetentionDays`. The result is validated after merging, so a patch " +
      "that would leave the policy demanding nothing is rejected.",
    request: {
      params: OrgIdParam.extend({ policyId: Uuid }),
      body: { content: { "application/json": { schema: BackupPolicyUpdate } } },
    },
    responses: {
      200: {
        description: "The updated policy",
        content: { "application/json": { schema: BackupPolicy } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/backups/policies/{policyId}",
    tags: ["Backup coverage"],
    summary: "Delete a backup policy",
    description:
      "Removes the objective. To stop a policy judging without losing it, set `enabled` to " +
      "false instead.",
    request: { params: OrgIdParam.extend({ policyId: Uuid }) },
    responses: {
      204: { description: "The policy was deleted" },
      404: ErrorResponses[404],
    },
  });
}

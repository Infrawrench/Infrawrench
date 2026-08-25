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

  const DrillOutcome = z.enum(["verified", "restored-unverified", "failed", "blocked"]).openapi({
    description:
      "How the drill ended. Only `verified` counts as evidence the backup works: a restore that " +
      "produced a running system nobody looked inside is exactly how a team discovers, " +
      "mid-incident, that the dump had been empty for months. `restored-unverified` is recorded " +
      "because doing the restore is worth recording, but it does not reset the clock.",
  });

  const DrillStanding = z.enum(["verified", "stale", "failed", "never"]).openapi({
    description:
      "`never` and `stale` are kept apart because they call for different conversations: one is " +
      "'nobody has ever tried', the other is 'it worked in March'.",
  });

  const RestoreDrill = strict({
    id: Uuid,
    resourceId: z.string(),
    resourceName: z.string().nullable(),
    accountId: Uuid.nullable(),
    accountName: z.string().nullable(),
    performedAt: IsoDateTime.describe(
      "When the drill was performed, which is **not** when it was recorded — people write these " +
        "up on Monday for a drill they ran on Saturday, and every staleness computation uses this.",
    ),
    outcome: DrillOutcome,
    rtoMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Measured wall-clock minutes. Null when the drill never got that far; a blocked drill has " +
          "no RTO, and an invented one would be the most dangerous number on the page.",
      ),
    restoredFrom: z.string().nullable().describe("Snapshot id, S3 key, a date — free text."),
    notes: z.string().nullable(),
    performedByUserId: Uuid.nullable(),
    performedByName: z.string().nullable(),
    createdAt: IsoDateTime,
  }).openapi("RestoreDrill");

  const DrillCoverageRow = strict({
    resourceId: z.string(),
    resourceName: z.string().nullable(),
    accountId: Uuid.nullable(),
    accountName: z.string().nullable(),
    resourceTypeId: z.string().nullable(),
    standing: DrillStanding,
    lastDrillAt: IsoDateTime.nullable(),
    lastOutcome: DrillOutcome.nullable(),
    lastVerifiedAt: IsoDateTime.nullable(),
    verifiedRtoMinutes: z.number().int().nullable(),
    daysUntilStale: z.number().int().nullable(),
  }).openapi("DrillCoverageRow");

  const DrillSummary = strict({
    eligibleCount: z
      .number()
      .int()
      .describe(
        "Resources with something to restore from. A resource with no backup cannot be drilled, " +
          "and listing it here would duplicate the coverage page's own unprotected finding.",
      ),
    verifiedCount: z.number().int(),
    staleCount: z.number().int(),
    failedCount: z.number().int(),
    neverCount: z.number().int(),
    worstRtoMinutes: z
      .number()
      .int()
      .nullable()
      .describe("Over currently-verified rows only; null when nothing is verified, never zero."),
    medianRtoMinutes: z.number().int().nullable(),
  }).openapi("DrillSummary");

  const DrillCoverageResponse = strict({
    rows: z.array(DrillCoverageRow),
    summary: DrillSummary,
    validDays: z.number().int(),
    orphanedDrills: z
      .array(RestoreDrill)
      .describe(
        "Drills against a resource no longer in the inventory. Reported rather than dropped: " +
          "'we tested this and then removed it' is a fact an auditor asks about.",
      ),
    generatedAt: IsoDateTime,
  }).openapi("DrillCoverageResponse");

  const RestoreDrillCreate = strict({
    resourceId: z.string(),
    performedAt: IsoDateTime,
    outcome: DrillOutcome,
    rtoMinutes: z.number().int().min(0).max(10080).nullable().optional(),
    restoredFrom: z.string().max(300).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  }).openapi("RestoreDrillCreate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/backups/drills",
    tags: ["Backup coverage"],
    summary: "Where every protected resource stands on restore",
    description:
      "Backup coverage answers 'is there a backup'. This answers 'does it restore, and how long " +
      "does it take' — a different question, and the one routinely answered wrongly on the day.\n\n" +
      "A drill is a **record that somebody tried**, not an automated restore: restoring a " +
      "customer's database unattended costs real money, can collide with production, and cannot " +
      "be generically verified. What the product can do is make the exercise scheduled, recorded " +
      "and visible when it lapses.",
    request: {
      params: OrgIdParam,
      query: z.object({
        validDays: z.coerce
          .number()
          .int()
          .min(7)
          .max(730)
          .optional()
          .describe("How long a verified drill counts for. Defaults to 180 days."),
      }),
    },
    responses: {
      200: {
        description: "Standings and the summary",
        content: { "application/json": { schema: DrillCoverageResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/backups/drills/log",
    tags: ["Backup coverage"],
    summary: "List recorded restore drills",
    request: {
      params: OrgIdParam,
      query: z.object({ resourceId: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Drills, most recently performed first",
        content: {
          "application/json": { schema: strict({ drills: z.array(RestoreDrill) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/backups/drills",
    tags: ["Backup coverage"],
    summary: "Record a restore drill",
    description:
      "A `verified` drill **must** carry the measured time: an RPO comes from the backup, and an " +
      "RTO can only come from somebody with a stopwatch — that number is the entire point of the " +
      "exercise. A `blocked` drill must not carry one, because it never started.\n\n" +
      "Takes `resources:write`, not a settings permission: recording a drill is reporting what " +
      "you did, and the person who spent Saturday restoring a database is rarely the person who " +
      "set the recovery objective.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: RestoreDrillCreate } } },
    },
    responses: {
      200: {
        description: "The recorded drill",
        content: { "application/json": { schema: RestoreDrill } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/backups/drills/{drillId}",
    tags: ["Backup coverage"],
    summary: "Delete a recorded drill",
    description:
      "For one recorded against the wrong resource or the wrong date. Audited — deleting evidence " +
      "that a restore failed is exactly the edit a reviewer would want to know about.",
    request: { params: OrgIdParam.extend({ drillId: Uuid }) },
    responses: { 204: { description: "The drill was deleted" }, 404: ErrorResponses[404] },
  });

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

/**
 * Backup coverage: `/api/org/:orgId/backups`, the endpoint definitions.
 *
 * The reads take `resources:read` (a view of the org's inventory). The
 * policies take `org:settings:write`, the posture-settings stance: a recovery
 * objective is an org-wide statement, and a member who can read the screen
 * deliberately cannot relax the target that judges it. Recording or deleting
 * a restore drill is `resources:write`: it reports what somebody did.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

const BackupSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
  description: "How bad the gap is. Orphaned backups are always `low`: they cost money, not data.",
});

const BackupFindingKind = Schema.Literals([
  "unprotected",
  "rpo-breach",
  "retention-below-policy",
  "orphaned-snapshot",
]).annotate({
  description:
    "What the finding describes: nothing protects the resource; the newest backup is older " +
    "than the policy's RPO; the provider-native retention window is shorter than the policy " +
    "asks; or a backup whose source resource no longer exists.",
});

const BackupProtectionState = Schema.Literals([
  "protected",
  "automated",
  "stale",
  "unknown",
  "unprotected",
]).annotate({
  description:
    "How the resource reads at a glance. `automated` means the provider is taking backups we " +
    "cannot enumerate, so there is a restore point but no listable one. `unknown` means the " +
    "resource type declares a provider-native automated-backup signal but this instance's " +
    "value could not be read; it is unassessed, not a confirmed gap, and never produces a " +
    "finding.",
});

const BackupFinding = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id the finding is on." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["DigitalOcean"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["Volume"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  kind: BackupFindingKind,
  severity: BackupSeverity,
  title: Schema.String.annotate({ examples: ["No backup of this volume"] }),
  detail: Schema.String.annotate({
    description: "Sentence explaining the gap and what would close it.",
  }),
  policyId: Schema.NullOr(Uuid).annotate({
    description:
      "The policy supplying the objective this finding breaches; the RPO policy for " +
      "`rpo-breach`, the retention policy for `retention-below-policy`. Null when no policy " +
      "applies.",
  }),
  policyName: Schema.NullOr(Schema.String),
  rpoHours: Schema.NullOr(Schema.Finite).annotate({
    description: "Hours since the newest backup protecting the resource; null when there is none.",
  }),
  maxRpoHours: Schema.NullOr(Schema.Int).annotate({
    description: "The policy's allowance, when one applied.",
  }),
  retentionDays: Schema.NullOr(Schema.Finite).annotate({
    description: "Provider-native retention window in days, when the plugin syncs one.",
  }),
  minRetentionDays: Schema.NullOr(Schema.Int),
  latestBackupId: Schema.NullOr(Schema.String),
  latestBackupName: Schema.NullOr(Schema.String),
  latestBackupAt: Schema.NullOr(IsoDateTime),
  sizeGb: Schema.NullOr(Schema.Finite).annotate({
    description: "Size of an orphaned backup in GiB, when the plugin syncs one.",
  }),
  monthlyCost: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Trailing-30-day spend on an orphaned backup. Null means the cost could not be " +
      "determined: never that the backup is free.",
  }),
  currency: Schema.NullOr(Schema.String),
}).annotate({ identifier: "BackupFinding" });

const BackupCoverageRow = Schema.Struct({
  resourceId: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  state: BackupProtectionState,
  backupCount: Schema.Int.annotate({
    description: "Backups in the inventory that protect this resource.",
  }),
  latestBackupId: Schema.NullOr(Schema.String),
  latestBackupName: Schema.NullOr(Schema.String),
  latestBackupAt: Schema.NullOr(IsoDateTime),
  rpoHours: Schema.NullOr(Schema.Finite),
  automatedBackups: Schema.NullOr(Schema.Boolean).annotate({
    description:
      "Whether provider-native automated backups are on. Null means the plugin syncs no " +
      "signal either way; which never counts as protection and never counts as a fault.",
  }),
  retentionDays: Schema.NullOr(Schema.Finite),
  rpoPolicyId: Schema.NullOr(Uuid).annotate({
    description:
      "The policy supplying `maxRpoHours`: the strictest RPO among those selecting this " +
      "resource. Tracked separately from the retention policy because the two strictest " +
      "demands routinely come from different policies.",
  }),
  rpoPolicyName: Schema.NullOr(Schema.String),
  retentionPolicyId: Schema.NullOr(Uuid).annotate({
    description: "The policy supplying `minRetentionDays`.",
  }),
  retentionPolicyName: Schema.NullOr(Schema.String),
  maxRpoHours: Schema.NullOr(Schema.Int),
  minRetentionDays: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "BackupCoverageRow" });

const BackupSeverityCounts = Schema.Struct({
  critical: Schema.Int,
  high: Schema.Int,
  medium: Schema.Int,
  low: Schema.Int,
}).annotate({ identifier: "BackupSeverityCounts" });

const BackupKindCounts = Schema.Struct({
  unprotected: Schema.Int,
  "rpo-breach": Schema.Int,
  "retention-below-policy": Schema.Int,
  "orphaned-snapshot": Schema.Int,
}).annotate({ identifier: "BackupKindCounts" });

const BackupCoverageSummary = Schema.Struct({
  statefulCount: Schema.Int.annotate({
    description: "Stateful resources the plugin declarations can judge.",
  }),
  protectedCount: Schema.Int,
  unprotectedCount: Schema.Int.annotate({
    description: "Confirmed gaps. Excludes unassessed resources; this is what the digest counts.",
  }),
  unknownCount: Schema.Int.annotate({
    description:
      "Resources that could not be assessed: the type declares a provider-native " +
      "automated-backup signal but this instance's value was absent or unrecognised. " +
      "Reported separately so 'we found no gap' and 'we could not tell' do not read alike.",
  }),
  backupCount: Schema.Int,
  orphanedBackupCount: Schema.Int,
  unattributableBackupCount: Schema.Int.annotate({
    description:
      "Backups whose source could not be determined; the plugin syncs no source field, the " +
      "field was empty, or more than one resource answered to it. Reported rather than " +
      "hidden: 'we found no orphans' and 'we could not tell' are different answers.",
  }),
  orphanedGb: Schema.NullOr(Schema.Finite),
  orphanedMonthlyCost: Schema.NullOr(Schema.Finite).annotate({
    description: "Null when billing data is unavailable or the orphans span several currencies.",
  }),
  currency: Schema.NullOr(Schema.String),
  worstRpoHours: Schema.NullOr(Schema.Finite).annotate({
    description: "Largest RPO across resources that have a datable backup at all.",
  }),
}).annotate({ identifier: "BackupCoverageSummary" });

export const BackupCoverageResponse = Schema.Struct({
  findings: Schema.Array(BackupFinding).annotate({ description: "Gaps, worst severity first." }),
  counts: BackupSeverityCounts,
  kindCounts: BackupKindCounts,
  totalCount: Schema.Int,
  resources: Schema.Array(BackupCoverageRow),
  summary: BackupCoverageSummary,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "BackupCoverageResponse" });

export const BackupPolicy = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  resourceTypeIds: Schema.Array(Schema.String).annotate({
    description: "Resource types the policy selects; empty selects every stateful type.",
  }),
  tagKey: Schema.NullOr(Schema.String).annotate({
    description: "Tag key that must be present. Matched case-insensitively.",
  }),
  tagValue: Schema.NullOr(Schema.String).annotate({
    description: "Required value of `tagKey`, matched exactly. Null means presence is enough.",
  }),
  maxRpoHours: Schema.NullOr(Schema.Int).annotate({
    description: "The newest backup must be no older than this. Null means no RPO demand.",
  }),
  minRetentionDays: Schema.NullOr(Schema.Int).annotate({
    description: "Provider-native retention must be at least this. Null means no demand.",
  }),
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "BackupPolicy" });

export const BackupPolicyList = Schema.Struct({ policies: Schema.Array(BackupPolicy) }).annotate({
  identifier: "BackupPolicyList",
});

/** The policy bodies are documented; the handlers check each field and the store the bounds. */
const policyFields = {
  resourceTypeIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
  tagKey: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(128)))),
  tagValue: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(256)))),
  maxRpoHours: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8760 }))),
  ),
  minRetentionDays: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }))),
  ),
  enabled: Schema.optionalKey(Schema.Boolean),
};

const PolicyName = Schema.String.check(minLength(1), maxLength(120));

const BackupPolicyCreate = Schema.Struct({ name: PolicyName, ...policyFields }).annotate({
  identifier: "BackupPolicyCreate",
});

const BackupPolicyUpdate = Schema.Struct({
  name: Schema.optionalKey(PolicyName),
  ...policyFields,
}).annotate({ identifier: "BackupPolicyUpdate" });

const DrillOutcome = Schema.Literals([
  "verified",
  "restored-unverified",
  "failed",
  "blocked",
]).annotate({
  description:
    "How the drill ended. Only `verified` counts as evidence the backup works: a restore that " +
    "produced a running system nobody looked inside is exactly how a team discovers, " +
    "mid-incident, that the dump had been empty for months. `restored-unverified` is recorded " +
    "because doing the restore is worth recording, but it does not reset the clock.",
});

const DrillStanding = Schema.Literals(["verified", "stale", "failed", "never"]).annotate({
  description:
    "`never` and `stale` are kept apart because they call for different conversations: one is " +
    "'nobody has ever tried', the other is 'it worked in March'.",
});

export const RestoreDrill = Schema.Struct({
  id: Uuid,
  resourceId: Schema.String,
  resourceName: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Uuid),
  accountName: Schema.NullOr(Schema.String),
  performedAt: IsoDateTime.annotate({
    description:
      "When the drill was performed, which is **not** when it was recorded; people write these " +
      "up on Monday for a drill they ran on Saturday, and every staleness computation uses this.",
  }),
  outcome: DrillOutcome,
  rtoMinutes: Schema.NullOr(Schema.Int).annotate({
    description:
      "Measured wall-clock minutes. Null when the drill never got that far; a blocked drill has " +
      "no RTO, and an invented one would be the most dangerous number on the page.",
  }),
  restoredFrom: Schema.NullOr(Schema.String).annotate({
    description: "Snapshot id, S3 key, a date, free text.",
  }),
  notes: Schema.NullOr(Schema.String),
  performedByUserId: Schema.NullOr(Uuid),
  performedByName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "RestoreDrill" });

const DrillCoverageRow = Schema.Struct({
  resourceId: Schema.String,
  resourceName: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Uuid),
  accountName: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  standing: DrillStanding,
  lastDrillAt: Schema.NullOr(IsoDateTime),
  lastOutcome: Schema.NullOr(DrillOutcome),
  lastVerifiedAt: Schema.NullOr(IsoDateTime),
  verifiedRtoMinutes: Schema.NullOr(Schema.Int),
  daysUntilStale: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "DrillCoverageRow" });

const DrillSummary = Schema.Struct({
  eligibleCount: Schema.Int.annotate({
    description:
      "Resources with something to restore from. A resource with no backup cannot be drilled, " +
      "and listing it here would duplicate the coverage page's own unprotected finding.",
  }),
  verifiedCount: Schema.Int,
  staleCount: Schema.Int,
  failedCount: Schema.Int,
  neverCount: Schema.Int,
  worstRtoMinutes: Schema.NullOr(Schema.Int).annotate({
    description: "Over currently-verified rows only; null when nothing is verified, never zero.",
  }),
  medianRtoMinutes: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "DrillSummary" });

export const DrillCoverageResponse = Schema.Struct({
  rows: Schema.Array(DrillCoverageRow),
  summary: DrillSummary,
  validDays: Schema.Int,
  orphanedDrills: Schema.Array(RestoreDrill).annotate({
    description:
      "Drills against a resource no longer in the inventory. Reported rather than dropped: " +
      "'we tested this and then removed it' is a fact an auditor asks about.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "DrillCoverageResponse" });

export const RestoreDrillLog = Schema.Struct({ drills: Schema.Array(RestoreDrill) });

/** Documented; the handler checks each field and server-core the bounds. */
const RestoreDrillCreate = Schema.Struct({
  resourceId: Schema.String,
  performedAt: IsoDateTime,
  outcome: DrillOutcome,
  rtoMinutes: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10080 }))),
  ),
  restoredFrom: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(300)))),
  notes: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(4000)))),
}).annotate({ identifier: "RestoreDrillCreate" });

const TAG = "Backup coverage";

export class BackupsGroup extends HttpApiGroup.make("backups")
  .add(
    HttpApiEndpoint.get("drillCoverage", "/drills", {
      params: OrgParams,
      query: {
        validDays: Schema.optionalKey(
          documentedAs(
            Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 730 })).annotate({
              description: "How long a verified drill counts for. Defaults to 180 days.",
            }),
          ),
        ),
      },
      success: DrillCoverageResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Where every protected resource stands on restore")
      .annotate(
        OpenApi.Description,
        "Backup coverage answers 'is there a backup'. This answers 'does it restore, and how long " +
          "does it take'; a different question, and the one routinely answered wrongly on the day.\n\n" +
          "A drill is a **record that somebody tried**, not an automated restore: restoring a " +
          "customer's database unattended costs real money, can collide with production, and cannot " +
          "be generically verified. What the product can do is make the exercise scheduled, recorded " +
          "and visible when it lapses.",
      )
      .annotate(SuccessDescription, "Standings and the summary"),
    HttpApiEndpoint.get("drillLog", "/drills/log", {
      params: OrgParams,
      query: { resourceId: Schema.optionalKey(Schema.String) },
      success: RestoreDrillLog,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List recorded restore drills")
      .annotate(SuccessDescription, "Drills, most recently performed first"),
    HttpApiEndpoint.post("recordDrill", "/drills", {
      params: OrgParams,
      payload: RestoreDrillCreate,
      success: RestoreDrill,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Record a restore drill")
      .annotate(
        OpenApi.Description,
        "A `verified` drill **must** carry the measured time: an RPO comes from the backup, and an " +
          "RTO can only come from somebody with a stopwatch; that number is the entire point of the " +
          "exercise. A `blocked` drill must not carry one, because it never started.\n\n" +
          "Takes `resources:write`, not a settings permission: recording a drill is reporting what " +
          "you did, and the person who spent Saturday restoring a database is rarely the person who " +
          "set the recovery objective.",
      )
      .annotate(SuccessDescription, "The recorded drill")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteDrill", "/drills/:drillId", {
      params: { orgId: OrgId, drillId: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a recorded drill")
      .annotate(
        OpenApi.Description,
        "For one recorded against the wrong resource or the wrong date. Audited: deleting evidence " +
          "that a restore failed is exactly the edit a reviewer would want to know about.",
      )
      .annotate(SuccessDescription, "The drill was deleted"),
    HttpApiEndpoint.get("coverage", "/", {
      params: OrgParams,
      success: BackupCoverageResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List backup coverage across synced resources")
      .annotate(
        OpenApi.Description,
        "What protects the organization's stateful resources, what does not, and which backups " +
          "protect nothing. Derived from already-synced inventory using the `backupRole` and " +
          "`backupPolicy` declarations plugins carry on their resource types; no provider API " +
          "calls are made and results reflect the last sync. Findings are recomputed on every " +
          "read rather than stored. Orphaned backups carry a trailing-30-day spend quote when " +
          "billing data is available.",
      )
      .annotate(SuccessDescription, "Backup coverage, worst findings first"),
    HttpApiEndpoint.get("listPolicies", "/policies", {
      params: OrgParams,
      success: BackupPolicyList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List the organization's backup policies")
      .annotate(
        OpenApi.Description,
        "The recovery objectives coverage is judged against. A policy selects resources by type " +
          "and/or tag and demands a maximum RPO, a minimum retention, or both.",
      )
      .annotate(SuccessDescription, "The organization's backup policies, newest first"),
    HttpApiEndpoint.post("createPolicy", "/policies", {
      params: OrgParams,
      payload: BackupPolicyCreate,
      success: BackupPolicy,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a backup policy")
      .annotate(
        OpenApi.Description,
        "A policy must demand at least one of `maxRpoHours` and `minRetentionDays`: one that " +
          "demands nothing could never produce a finding and would read as protection while " +
          "providing none. An empty `resourceTypeIds` selects every stateful resource type.",
      )
      .annotate(SuccessDescription, "The created policy")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("updatePolicy", "/policies/:policyId", {
      params: { orgId: OrgId, policyId: Uuid },
      payload: BackupPolicyUpdate,
      success: BackupPolicy,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update a backup policy")
      .annotate(
        OpenApi.Description,
        "Omitted fields are left alone; an explicit `null` clears `tagKey`, `tagValue`, " +
          "`maxRpoHours` or `minRetentionDays`. The result is validated after merging, so a patch " +
          "that would leave the policy demanding nothing is rejected.",
      )
      .annotate(SuccessDescription, "The updated policy")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deletePolicy", "/policies/:policyId", {
      params: { orgId: OrgId, policyId: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a backup policy")
      .annotate(
        OpenApi.Description,
        "Removes the objective. To stop a policy judging without losing it, set `enabled` to " +
          "false instead.",
      )
      .annotate(SuccessDescription, "The policy was deleted"),
  )
  .prefix("/api/org/:orgId/backups")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, TAG) {}

export class BackupsApi extends withApiDefaults(HttpApi.make("backups").add(BackupsGroup)) {}

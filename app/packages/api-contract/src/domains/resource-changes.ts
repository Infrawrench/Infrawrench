/**
 * The change timeline: `/api/org/:orgId/changes`, the endpoint definitions.
 *
 * The feed and the per-resource history are `resources:read`. The drift alert
 * filter is `org:settings:write`: it decides who the org's channels and
 * phones hear from, the trust level of the Slack, Teams and digest settings
 * beside it. Cost per change is `costs:read` and `resources:read` (money keyed
 * to specific resources and their history). A revert, and its dry run, are
 * `resources:write`: the plan names the write it offers to make and costs a
 * live provider call. Bodies are read raw by the handlers, which answer a
 * malformed field with their own sentence.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import {
  BadGateway,
  BadRequest,
  Conflict,
  Forbidden,
  InternalServerError,
  NotFound,
} from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { ChangeCostBasis, ChangeCostImpact } from "../http/schemas/change-cost-impact";
import { ChangeFreezeBlocked } from "../http/schemas/change-freeze";
import { IsoDateTime, OrgId, OrgParams, ResourceId, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ResourceChangeKind = Schema.Literals(["created", "updated", "deleted"]).annotate({
  identifier: "ResourceChangeKind",
  description:
    "What happened between two consecutive syncs: the resource appeared, a stored field changed, or the resource disappeared upstream.",
});

const ResourceFieldChange = Schema.Struct({
  field: Schema.String.annotate({
    description: "Top-level field key that changed. Resolved-output keys are prefixed `outputs.`.",
  }),
  // Optional as documented: an arbitrary value may be `undefined`, which JSON omits.
  from: Schema.optionalKey(
    Schema.Any.annotate({ description: "Previous value (null when the field was absent)." }),
  ),
  to: Schema.optionalKey(Schema.Any.annotate({ description: "New value." })),
}).annotate({ identifier: "ResourceFieldChange" });

const resourceChangeEntryFields = {
  id: Uuid,
  resourceId: ResourceId,
  accountId: Uuid,
  /** Plain strings, not the live plugin enums: history may reference a plugin that was since removed. */
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  displayName: Schema.String.annotate({
    description: "Resource display name at the time of the change, survives deletion.",
  }),
  changeKind: ResourceChangeKind,
  diff: Schema.Array(ResourceFieldChange).annotate({
    description: "Changed fields for `updated` events; empty for `created` and `deleted`.",
  }),
  origin: Schema.optionalKey(
    Schema.NullOr(Schema.Literal("schedule")).annotate({
      description:
        "Who caused the change when a non-sync writer knows: `schedule` for sleep/wake " +
        "schedule transitions. Absent/null = observed by sync.",
    }),
  ),
  createdAt: IsoDateTime,
  revertedAt: Schema.optionalKey(
    Schema.NullOr(IsoDateTime).annotate({
      description:
        "When this event was reverted, or null if it never was. Reverting is a one-shot: an event " +
        "carrying a timestamp here cannot be reverted again.",
    }),
  ),
};

const ResourceChangeEntry = Schema.Struct(resourceChangeEntryFields).annotate({
  identifier: "ResourceChangeEntry",
});

const ResourceChangeFeedEntry = Schema.Struct({
  ...resourceChangeEntryFields,
  accountName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ResourceChangeFeedEntry" });

export const ResourceChangeFeedResponse = Schema.Struct({
  entries: Schema.Array(ResourceChangeFeedEntry),
  total: NonNegativeInt,
}).annotate({ identifier: "ResourceChangeFeedResponse" });

export const ResourceChangeListResponse = Schema.Struct({
  entries: Schema.Array(ResourceChangeEntry),
}).annotate({ identifier: "ResourceChangeListResponse" });

const CooldownMinutes = Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1440 }));
const MinChanges = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));

export const DriftAlertSettings = Schema.Struct({
  notifyCreated: Schema.Boolean.annotate({ description: "Alert on resources that appeared." }),
  notifyUpdated: Schema.Boolean.annotate({
    description:
      "Alert on field-level updates. Defaults to false; updates are the bulk of the volume and are usually a provider restating a value.",
  }),
  notifyDeleted: Schema.Boolean.annotate({ description: "Alert on resources that disappeared." }),
  cooldownMinutes: CooldownMinutes.annotate({
    description:
      "Least time between drift notifications for this organization. One notification per window, no matter how many changes or accounts it covers.",
  }),
  minChanges: MinChanges.annotate({
    description: "Fewest matching changes in a window worth notifying about.",
  }),
  accountIds: Schema.Array(Uuid).annotate({
    description: "Accounts to alert on. An empty array means every account.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When this organization last had a drift digest delivered.",
  }),
}).annotate({ identifier: "DriftAlertSettings" });

/** Documented; the handler checks each field itself and server-core owns the bounds. */
const DriftAlertSettingsUpdate = Schema.Struct({
  notifyCreated: Schema.optionalKey(Schema.Boolean),
  notifyUpdated: Schema.optionalKey(Schema.Boolean),
  notifyDeleted: Schema.optionalKey(Schema.Boolean),
  cooldownMinutes: Schema.optionalKey(CooldownMinutes),
  minChanges: Schema.optionalKey(MinChanges),
  accountIds: Schema.optionalKey(Schema.Array(Uuid).check(maxLength(200))),
}).annotate({ identifier: "DriftAlertSettingsUpdate" });

const ChangeCostImpactEntry = Schema.Struct({
  changeId: Uuid,
  resourceId: ResourceId,
  impact: ChangeCostImpact,
}).annotate({ identifier: "ChangeCostImpactEntry" });

/** Documented; the handler checks the ids and the basis itself. */
const ChangeCostImpactsRequest = Schema.Struct({
  changeIds: Schema.Array(Uuid)
    .annotate({ description: "Change ids from `GET /changes`. At most 50: one feed page." })
    .check(maxLength(50)),
  windowDays: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Days either side of the change. Default 7; clamped server-side.",
    }).check(Schema.isBetween({ minimum: 2, maximum: 30 })),
  ),
  costBasis: Schema.optionalKey(ChangeCostBasis),
}).annotate({ identifier: "ChangeCostImpactsRequest" });

export const ChangeCostImpactsResponse = Schema.Struct({
  impacts: Schema.Array(ChangeCostImpactEntry),
}).annotate({ identifier: "ChangeCostImpactsResponse" });

const RevertFieldStatus = Schema.Literals([
  "revertible",
  "already-reverted",
  "conflict",
  "not-writable",
  "provider-derived",
]).annotate({
  identifier: "RevertFieldStatus",
  description:
    "What a revert would do to one field. `revertible`: the field still holds the value the " +
    "change set, and the plugin's edit form can write the old one back. `already-reverted`: it " +
    "is already at the old value; nothing to do. `conflict`: it changed again since, so " +
    "reverting would discard the newer value. `not-writable`: outside the plugin's editable " +
    "surface, or the old value is not something the edit form can submit. `provider-derived`: " +
    "an `outputs.*` entry, which the provider computes rather than accepts.",
});

const RevertFieldPlan = Schema.Struct({
  field: Schema.String,
  // Optional as documented: an arbitrary value may be `undefined`, which JSON omits.
  revertTo: Schema.optionalKey(
    Schema.Any.annotate({ description: "The value a revert would write." }),
  ),
  changedTo: Schema.optionalKey(
    Schema.Any.annotate({ description: "The value the recorded change set." }),
  ),
  current: Schema.optionalKey(
    Schema.Any.annotate({ description: "The value the resource holds right now, read live." }),
  ),
  status: RevertFieldStatus,
  reason: Schema.String.annotate({ description: "One sentence explaining the status." }),
}).annotate({ identifier: "RevertFieldPlan" });

const RevertPlan = Schema.Struct({
  fields: Schema.Array(RevertFieldPlan).annotate({
    description: "Every field of the recorded diff, in the order the event recorded them.",
  }),
  revertibleFields: Schema.Array(Schema.String).annotate({
    description: "The keys that would actually be written.",
  }),
  revertible: Schema.Boolean,
  blockedReason: Schema.NullOr(Schema.String).annotate({
    description: "Why nothing would be written, or null when something would.",
  }),
}).annotate({ identifier: "RevertPlan" });

export const RevertPreviewResponse = Schema.Struct({
  changeId: Uuid,
  resourceId: ResourceId,
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  plan: RevertPlan,
  revertedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "RevertPreviewResponse" });

export const RevertApplyResponse = Schema.Struct({
  changeId: Uuid,
  resourceId: ResourceId,
  appliedFields: Schema.Array(Schema.String).annotate({
    description: "The fields written, in plan order. Empty on a reconciliation.",
  }),
  plan: RevertPlan,
  revertedAt: IsoDateTime,
  reconciled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "True when this request wrote nothing and instead recorded an *earlier* interrupted " +
        "attempt's write: the resource was already back, and the event is now marked reverted. " +
        "Nothing was sent to the provider by this request.",
    }),
  ),
  auditRecorded: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Present and `false` only when the audit entry could not be written. The provider change " +
        "still happened; its attribution did not reach the audit table and was written to the " +
        "server log instead. Attribution is best-effort; nothing transactional spans a " +
        "third-party cloud API and Infrawrench's database.",
    }),
  ),
}).annotate({ identifier: "RevertApplyResponse" });

const ChangeParams = { orgId: OrgId, changeId: Uuid } as const;

export class ResourceChangesGroup extends HttpApiGroup.make("changes")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      // Read raw: page and pageSize are parsed and clamped by the handler, and
      // an unknown kind is its own 400.
      query: {
        page: Schema.optionalKey(Schema.String),
        pageSize: Schema.optionalKey(Schema.String),
        accountId: Schema.optionalKey(Uuid),
        resourceId: Schema.optionalKey(Schema.String),
        kind: Schema.optionalKey(documentedAs(ResourceChangeKind)),
        from: Schema.optionalKey(IsoDateTime),
        to: Schema.optionalKey(IsoDateTime),
      },
      success: ResourceChangeFeedResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Org-wide change timeline (paginated, filterable)")
      .annotate(
        OpenApi.Description,
        "Change events recorded by the resource poller: each poll cycle diffs the freshly fetched " +
          "state against the stored snapshot and records resources that appeared, changed a stored " +
          "field, or disappeared upstream. Cross-provider by construction; the diff runs on the " +
          "generic stored record, so every plugin's resources show up here.",
      )
      .annotate(SuccessDescription, "Change events, newest first")
      .annotate(
        OpenApi.Transform,
        numericQuery({
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 200 },
        }),
      ),
    HttpApiEndpoint.get("getAlertSettings", "/alert-settings", {
      params: OrgParams,
      success: DriftAlertSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's resource-drift alert filter")
      .annotate(
        OpenApi.Description,
        "Drift notifications are batched: at most one message per organization per `cooldownMinutes`, " +
          "covering every change since the previous one. These settings decide which changes count and " +
          "how often a message may go out. Who receives it is the `resourceDrift` opt-in on push " +
          "preferences, Slack channels and Teams webhooks; off by default on all three.",
      )
      .annotate(
        SuccessDescription,
        "Drift alert settings (defaults when the organization never saved any)",
      ),
    HttpApiEndpoint.put("updateAlertSettings", "/alert-settings", {
      params: OrgParams,
      payload: DriftAlertSettingsUpdate,
      success: DriftAlertSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the organization's resource-drift alert filter")
      .annotate(
        OpenApi.Description,
        "Every field is optional so a single toggle can be saved on its own. `cooldownMinutes` is " +
          "floored at 5: below the poller's own cycle the notification rate would follow the sync rate " +
          "again, which is what the batching exists to prevent.",
      )
      .annotate(SuccessDescription, "Updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("costImpacts", "/cost-impacts", {
      params: OrgParams,
      payload: ChangeCostImpactsRequest,
      success: ChangeCostImpactsResponse,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Cost impact of a page of changes")
      .annotate(
        OpenApi.Description,
        "For each change, compares the resource's per-day spend over the window before it against " +
          "the window after, and reports the difference as a run-rate delta.\n\n" +
          "A POST because it takes a list of ids, not because it writes: nothing is stored. The " +
          "answer is recomputed on every call, deliberately; provider cost arrives late and is then " +
          "restated, so a stored number would be a wrong number that never corrects itself.\n\n" +
          "Both windows exclude the change's own day (spend on it is half old shape, half new) and " +
          "today (an accruing day always reads as a dip), and are clamped symmetrically to the days " +
          "cost collection actually covers.",
      )
      .annotate(SuccessDescription, "One entry per change id that belongs to the organization")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("forResource", "/resource", {
      params: OrgParams,
      // Read raw: a missing id is the handler's own 400, and the limit is clamped.
      query: {
        resourceId: Schema.optionalKey(documentedAs(Schema.String.check(Schema.isMinLength(1)))),
        limit: Schema.optionalKey(Schema.String),
      },
      success: ResourceChangeListResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Change timeline for one resource")
      .annotate(
        OpenApi.Description,
        "Recent change events for a single resource, newest first. The resource id travels as a " +
          "query parameter because composite ids contain slashes and colons.",
      )
      .annotate(SuccessDescription, "Change events for the resource, newest first")
      .annotate(OpenApi.Transform, (op) =>
        requiredQuery(["resourceId"])(
          numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } })(op),
        ),
      ),
    HttpApiEndpoint.get("revertPreview", "/:changeId/revert", {
      params: ChangeParams,
      success: RevertPreviewResponse,
      error: [NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Dry-run a revert of one change event")
      .annotate(
        OpenApi.Description,
        "Inverts the recorded diff and reconciles it against the resource's *current* live fields, " +
          "which is the whole point: the poller may have recorded this hours ago and the world may " +
          "have moved on. Read-only: it reads from the provider and writes nothing.\n\n" +
          "Only `updated` events with a field diff can be reverted. `outputs.*` entries are " +
          "provider-derived and are never written back, and whether a field is writable at all is the " +
          "plugin's own edit-form rule (`editable`, minus `secret` and `association` kinds), so a " +
          "revert can never issue a provider call an edit could not.\n\n" +
          "Gated on `resources:write` rather than `resources:read`: the plan names the write it is " +
          "offering to make.",
      )
      .annotate(
        SuccessDescription,
        "The plan. A plan with `revertible: false` still lists every field and why each one is out.",
      ),
    HttpApiEndpoint.post("revert", "/:changeId/revert", {
      params: ChangeParams,
      success: RevertApplyResponse,
      error: [BadRequest, NotFound, Conflict, ChangeFreezeBlocked, InternalServerError, BadGateway],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Revert one change event")
      .annotate(
        OpenApi.Description,
        "Applies the inverse patch through the plugin's ordinary `updateResource` path (the same " +
          "call the Edit form makes) and only for the fields the dry run marked `revertible`.\n\n" +
          "The plan is rebuilt against a fresh live read immediately before the write, so a field that " +
          "moved between the preview and the apply becomes a conflict and drops out of the patch.\n\n" +
          "**This is a last-moment re-read, not an atomic compare-and-swap.** The gap between reading " +
          "a field and writing it is one provider round-trip wide, and a third party writing inside " +
          "that gap will be overwritten without warning. It cannot be closed generically: the plugin " +
          "update contract carries no expected value, ETag or version token, so no conditional write " +
          "can be expressed for a provider that supports one. Treat the conflict detection as a strong " +
          "guard against stale plans, not as a mutual-exclusion guarantee against other writers.\n\n" +
          "Reverts of the *same event* are mutually exclusive: the event is claimed with a conditional " +
          "update under a five-minute lease, so two concurrent reverts cannot both reach the provider " +
          "and the loser gets `409`. A provider failure releases the claim immediately; a process that " +
          "dies mid-write leaves a claim that expires, so an interrupted revert is retryable rather " +
          "than permanently stuck. `revertedAt` is only set once the provider accepted the write.\n\n" +
          "The claim carries an owner token, and every write that ends a revert is fenced on it. An " +
          "attempt whose provider call outlives the lease can therefore neither release nor complete " +
          "the claim that replaced it; it gets `409` with `appliedFields` naming what it did write, " +
          "so the caller can reconcile rather than assume. Two attempts can overlap in that case, but " +
          "they cannot disagree: both invert the same recorded event to the same values, so the second " +
          "one's patch is a subset of the first's.\n\n" +
          "If a write reaches the provider but recording it fails, the response is `500` with " +
          "`appliedFields`: the resource moved and the timeline has not caught up. The claim is " +
          "deliberately held in that case, and the next attempt after the lease expires finds every " +
          "field already back and records the revert without touching the provider again, answering " +
          "`200` with `reconciled: true` and an empty `appliedFields`. A resource put back by hand is " +
          "not mistaken for this: reconciliation only happens on an event whose claim was still " +
          "outstanding, which is the only state in which an unrecorded write is possible.\n\n" +
          "Blocked with `423` while an org change freeze is in effect. Every attempt whose write " +
          "reached the provider is audit-logged as `resource.change_revert`, including one that lost " +
          "its claim or could not record; the entry's `outcome` is `recorded`, `superseded`, " +
          "`unrecorded` or `reconciled`, so a contested outcome reads as one mutation rather than as " +
          "several reverts. An attempt that neither wrote nor recorded anything logs nothing. " +
          "Attribution is best-effort: no transaction spans a third-party cloud API and Infrawrench's " +
          "database, so if the audit insert itself fails the response carries `auditRecorded: false` " +
          "and the details go to the server log rather than being silently dropped.\n\n" +
          "The stored resource snapshot is deliberately left untouched, so the next poll observes the " +
          "reverted state and records it as an ordinary change event.",
      )
      .annotate(SuccessDescription, "The revert was applied"),
  )
  .prefix("/api/org/:orgId/changes")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Changes") {}

export class ResourceChangesApi extends withApiDefaults(
  HttpApi.make("changes").add(ResourceChangesGroup),
) {}

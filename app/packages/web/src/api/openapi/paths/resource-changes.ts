import { z } from "../zod";
import {
  strict,
  ErrorResponse,
  ErrorResponses,
  OrgIdParam,
  Uuid,
  IsoDateTime,
  ResourceId,
} from "../common";
import { FreezeLockedResponse } from "./change-freezes";
import type { BuildContext } from "../context";

const ResourceChangeKind = z.enum(["created", "updated", "deleted"]).openapi("ResourceChangeKind", {
  description:
    "What happened between two consecutive syncs: the resource appeared, a stored field changed, or the resource disappeared upstream.",
});

const ResourceFieldChange = strict({
  field: z.string().openapi({
    description: "Top-level field key that changed. Resolved-output keys are prefixed `outputs.`.",
  }),
  from: z.unknown().openapi({ description: "Previous value (null when the field was absent)." }),
  to: z.unknown().openapi({ description: "New value." }),
}).openapi("ResourceFieldChange");

const ResourceChangeEntry = strict({
  id: Uuid,
  resourceId: ResourceId,
  accountId: Uuid,
  /** Plain strings, not the live plugin enums: history may reference a plugin that was since removed. */
  pluginId: z.string(),
  resourceTypeId: z.string(),
  displayName: z.string().openapi({
    description: "Resource display name at the time of the change — survives deletion.",
  }),
  changeKind: ResourceChangeKind,
  diff: z.array(ResourceFieldChange).openapi({
    description: "Changed fields for `updated` events; empty for `created` and `deleted`.",
  }),
  origin: z
    .enum(["schedule"])
    .nullable()
    .optional()
    .openapi({
      description:
        "Who caused the change when a non-sync writer knows: `schedule` for sleep/wake " +
        "schedule transitions. Absent/null = observed by sync.",
    }),
  createdAt: IsoDateTime,
  revertedAt: IsoDateTime.nullable()
    .optional()
    .openapi({
      description:
        "When this event was reverted, or null if it never was. Reverting is a one-shot: an event " +
        "carrying a timestamp here cannot be reverted again.",
    }),
}).openapi("ResourceChangeEntry");

const ResourceChangeFeedEntry = ResourceChangeEntry.extend({
  accountName: z.string().nullable(),
}).openapi("ResourceChangeFeedEntry");

const ResourceChangeFeedResponse = strict({
  entries: z.array(ResourceChangeFeedEntry),
  total: z.number().int().nonnegative(),
}).openapi("ResourceChangeFeedResponse");

const ResourceChangeListResponse = strict({
  entries: z.array(ResourceChangeEntry),
}).openapi("ResourceChangeListResponse");

const DriftAlertSettings = strict({
  notifyCreated: z.boolean().openapi({ description: "Alert on resources that appeared." }),
  notifyUpdated: z.boolean().openapi({
    description:
      "Alert on field-level updates. Defaults to false — updates are the bulk of the volume and are usually a provider restating a value.",
  }),
  notifyDeleted: z.boolean().openapi({ description: "Alert on resources that disappeared." }),
  cooldownMinutes: z.number().int().min(5).max(1440).openapi({
    description:
      "Least time between drift notifications for this organization. One notification per window, no matter how many changes or accounts it covers.",
  }),
  minChanges: z.number().int().min(1).max(1000).openapi({
    description: "Fewest matching changes in a window worth notifying about.",
  }),
  accountIds: z.array(Uuid).openapi({
    description: "Accounts to alert on. An empty array means every account.",
  }),
  lastNotifiedAt: IsoDateTime.nullable().openapi({
    description: "When this organization last had a drift digest delivered.",
  }),
}).openapi("DriftAlertSettings");

// Registered under its own name — `.partial()` on a registered schema would
// otherwise collapse back into the full $ref in the generated document.
const DriftAlertSettingsUpdate = strict({
  notifyCreated: z.boolean().optional(),
  notifyUpdated: z.boolean().optional(),
  notifyDeleted: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(5).max(1440).optional(),
  minChanges: z.number().int().min(1).max(1000).optional(),
  accountIds: z.array(Uuid).max(200).optional(),
}).openapi("DriftAlertSettingsUpdate");

const RevertFieldStatus = z
  .enum(["revertible", "already-reverted", "conflict", "not-writable", "provider-derived"])
  .openapi("RevertFieldStatus", {
    description:
      "What a revert would do to one field. `revertible` — the field still holds the value the " +
      "change set, and the plugin's edit form can write the old one back. `already-reverted` — it " +
      "is already at the old value; nothing to do. `conflict` — it changed again since, so " +
      "reverting would discard the newer value. `not-writable` — outside the plugin's editable " +
      "surface, or the old value is not something the edit form can submit. `provider-derived` — " +
      "an `outputs.*` entry, which the provider computes rather than accepts.",
  });

const RevertFieldPlan = strict({
  field: z.string(),
  revertTo: z.unknown().openapi({ description: "The value a revert would write." }),
  changedTo: z.unknown().openapi({ description: "The value the recorded change set." }),
  current: z
    .unknown()
    .openapi({ description: "The value the resource holds right now, read live." }),
  status: RevertFieldStatus,
  reason: z.string().openapi({ description: "One sentence explaining the status." }),
}).openapi("RevertFieldPlan");

const RevertPlan = strict({
  fields: z.array(RevertFieldPlan).openapi({
    description: "Every field of the recorded diff, in the order the event recorded them.",
  }),
  revertibleFields: z.array(z.string()).openapi({
    description: "The keys that would actually be written.",
  }),
  revertible: z.boolean(),
  blockedReason: z
    .string()
    .nullable()
    .openapi({ description: "Why nothing would be written, or null when something would." }),
}).openapi("RevertPlan");

const RevertPreviewResponse = strict({
  changeId: Uuid,
  resourceId: ResourceId,
  displayName: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  plan: RevertPlan,
  revertedAt: IsoDateTime.nullable(),
}).openapi("RevertPreviewResponse");

const RevertApplyResponse = strict({
  changeId: Uuid,
  resourceId: ResourceId,
  appliedFields: z.array(z.string()).openapi({ description: "The fields written, in plan order." }),
  plan: RevertPlan,
  revertedAt: IsoDateTime,
}).openapi("RevertApplyResponse");

export function registerResourceChangePaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/changes",
    tags: ["Changes"],
    summary: "Org-wide change timeline (paginated, filterable)",
    description:
      "Change events recorded by the resource poller: each poll cycle diffs the freshly fetched " +
      "state against the stored snapshot and records resources that appeared, changed a stored " +
      "field, or disappeared upstream. Cross-provider by construction — the diff runs on the " +
      "generic stored record, so every plugin's resources show up here.",
    request: {
      params: OrgIdParam,
      query: strict({
        page: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .openapi({ param: { name: "page", in: "query" } }),
        pageSize: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .openapi({ param: { name: "pageSize", in: "query" } }),
        accountId: Uuid.optional().openapi({ param: { name: "accountId", in: "query" } }),
        resourceId: z
          .string()
          .optional()
          .openapi({ param: { name: "resourceId", in: "query" } }),
        kind: ResourceChangeKind.optional().openapi({ param: { name: "kind", in: "query" } }),
        from: IsoDateTime.optional().openapi({ param: { name: "from", in: "query" } }),
        to: IsoDateTime.optional().openapi({ param: { name: "to", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "Change events, newest first",
        content: { "application/json": { schema: ResourceChangeFeedResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/changes/alert-settings",
    tags: ["Changes"],
    summary: "Get the organization's resource-drift alert filter",
    description:
      "Drift notifications are batched: at most one message per organization per `cooldownMinutes`, " +
      "covering every change since the previous one. These settings decide which changes count and " +
      "how often a message may go out. Who receives it is the `resourceDrift` opt-in on push " +
      "preferences, Slack channels and Teams webhooks — off by default on all three.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Drift alert settings (defaults when the organization never saved any)",
        content: { "application/json": { schema: DriftAlertSettings } },
      },
    },
  });

  ctx.registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/changes/alert-settings",
    tags: ["Changes"],
    summary: "Update the organization's resource-drift alert filter",
    description:
      "Every field is optional so a single toggle can be saved on its own. `cooldownMinutes` is " +
      "floored at 5: below the poller's own cycle the notification rate would follow the sync rate " +
      "again, which is what the batching exists to prevent.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DriftAlertSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "Updated settings",
        content: { "application/json": { schema: DriftAlertSettings } },
      },
      400: ErrorResponses[400],
    },
  });

  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/changes/resource",
    tags: ["Changes"],
    summary: "Change timeline for one resource",
    description:
      "Recent change events for a single resource, newest first. The resource id travels as a " +
      "query parameter because composite ids contain slashes and colons.",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: z
          .string()
          .min(1)
          .openapi({ param: { name: "resourceId", in: "query" } }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "Change events for the resource, newest first",
        content: { "application/json": { schema: ResourceChangeListResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  const ChangeIdParam = OrgIdParam.extend({
    changeId: Uuid.openapi({ param: { name: "changeId", in: "path" } }),
  });

  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/changes/{changeId}/revert",
    tags: ["Changes"],
    summary: "Dry-run a revert of one change event",
    description:
      "Inverts the recorded diff and reconciles it against the resource's *current* live fields, " +
      "which is the whole point: the poller may have recorded this hours ago and the world may " +
      "have moved on. Read-only — it reads from the provider and writes nothing.\n\n" +
      "Only `updated` events with a field diff can be reverted. `outputs.*` entries are " +
      "provider-derived and are never written back, and whether a field is writable at all is the " +
      "plugin's own edit-form rule (`editable`, minus `secret` and `association` kinds), so a " +
      "revert can never issue a provider call an edit could not.\n\n" +
      "Gated on `resources:write` rather than `resources:read`: the plan names the write it is " +
      "offering to make.",
    request: { params: ChangeIdParam },
    responses: {
      200: {
        description:
          "The plan. A plan with `revertible: false` still lists every field and why each one is out.",
        content: { "application/json": { schema: RevertPreviewResponse } },
      },
      404: ErrorResponses[404],
      502: {
        description:
          "The provider couldn't be read, so no plan can be made safely. Nothing was written.",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  ctx.registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/changes/{changeId}/revert",
    tags: ["Changes"],
    summary: "Revert one change event",
    description:
      "Applies the inverse patch through the plugin's ordinary `updateResource` path — the same " +
      "call the Edit form makes — and only for the fields the dry run marked `revertible`.\n\n" +
      "The plan is recomputed against a fresh live read before the write, so a field that moved " +
      "between the preview and the apply becomes a conflict and drops out of the patch. On top of " +
      "that, the event itself is claimed with a conditional update: two concurrent reverts of the " +
      "same event cannot both reach the provider, and the loser gets `409`. A provider failure " +
      "releases the claim, so a failed attempt stays retryable.\n\n" +
      "Blocked with `423` while an org change freeze is in effect, and audit-logged as " +
      "`resource.change_revert`. The stored resource snapshot is deliberately left untouched, so " +
      "the next poll observes the reverted state and records it as an ordinary change event.",
    request: { params: ChangeIdParam },
    responses: {
      200: {
        description: "The revert was applied",
        content: { "application/json": { schema: RevertApplyResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description:
          "Already reverted, another revert holds the event, or nothing in the plan is writable. " +
          "The body carries `code: change_revert_conflict` for the first two.",
        content: { "application/json": { schema: ErrorResponse } },
      },
      423: FreezeLockedResponse,
      502: {
        description: "The provider couldn't be read. Nothing was written.",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });
}

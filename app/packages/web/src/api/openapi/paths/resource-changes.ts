import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, ResourceId } from "../common";
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
}

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

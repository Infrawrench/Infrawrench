/**
 * Resource leases (TTL): `/api/org/:orgId/leases`, the endpoint definitions.
 *
 * An optional "expires at" on any resource. Active leases ride the expiry
 * radar (kind `"lease"`); auto-delete leases are executed by the poller
 * (`server-core/src/leases/pass.ts`, two mandatory announcements,
 * freeze-aware). These endpoints only manage the rows.
 *
 * Permissions: reads are `resources:read` (the list is a view over the org's
 * resource set, like schedules); mutations are `resources:write`; except
 * that setting `autoDelete: true` additionally requires `resources:delete`,
 * because that lease is a standing instruction to delete the resource. That
 * second check is the handler's.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

/** The 409 a second active lease on one resource is refused with. */
export class LeaseConflict extends Schema.Error<LeaseConflict>("infrawrench/http/LeaseConflict")(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "LeaseConflict",
    description: "The resource already has an active lease",
  },
) {}

const LeaseStatus = Schema.Literals(["active", "deleted", "failed", "canceled"]).annotate({
  description:
    "Lease lifecycle: `active` (counting down), `deleted` (auto-delete completed), " +
    "`failed` (auto-delete was retried and given up on, see `lastError`), or " +
    "`canceled` (called off; the resource stays).",
});

export const ResourceLease = Schema.Struct({
  id: Uuid,
  resourceId: Schema.String.annotate({
    description: "Infrawrench resource id the lease is attached to.",
  }),
  accountId: Uuid,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceName: Schema.String.annotate({
    description: "Resource display name (denormalized at lease time, so it survives deletion).",
  }),
  accountName: Schema.String,
  expiresAt: IsoDateTime.annotate({ description: "The lease deadline." }),
  autoDelete: Schema.Boolean.annotate({
    description:
      "Whether the resource is deleted at expiry. Auto-delete is announced twice before it " +
      "fires and deferred while an org change freeze is in effect.",
  }),
  note: Schema.NullOr(Schema.String).annotate({
    description: "Why/who-for; shown on the expiry radar.",
  }),
  status: LeaseStatus,
  firstWarningAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the first auto-delete announcement went out; null until sent.",
  }),
  finalWarningAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the final auto-delete announcement went out; null until sent.",
  }),
  deleteAttempts: Schema.Int,
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Last auto-delete failure or freeze-deferral detail; never silent.",
  }),
  completedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the lease reached a terminal status.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ResourceLease" });

export const ResourceLeaseList = Schema.Struct({
  leases: Schema.Array(ResourceLease),
}).annotate({ identifier: "ResourceLeaseList" });

export const ResourceLeaseLookup = Schema.Struct({
  lease: Schema.NullOr(ResourceLease),
}).annotate({ identifier: "ResourceLeaseLookup" });

const ResourceLeaseCreate = Schema.Struct({
  resourceId: Schema.String,
  accountId: Uuid,
  expiresAt: IsoDateTime.annotate({ description: "Must be in the future, at most 365 days out." }),
  autoDelete: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Requires the `resources:delete` permission when true.",
    }),
  ),
  note: Schema.optionalKey(Schema.String.check(maxLength(500))),
}).annotate({ identifier: "ResourceLeaseCreate" });

const ResourceLeaseUpdate = Schema.Struct({
  expiresAt: Schema.optionalKey(IsoDateTime),
  autoDelete: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Requires the `resources:delete` permission when set to true.",
    }),
  ),
  note: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(500))).annotate({
      description: "`null` clears the note.",
    }),
  ),
}).annotate({ identifier: "ResourceLeaseUpdate" });

const LeaseParams = { orgId: OrgId, leaseId: Uuid } as const;

export class LeasesGroup extends HttpApiGroup.make("leases")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: ResourceLeaseList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List resource leases")
      .annotate(
        OpenApi.Description,
        "Every lease in the organization, soonest deadline first. Active leases also appear on " +
          "the expiry radar (`GET /expiring`) as kind `lease` items, so the owner is nagged " +
          "through the existing expiry alerts.",
      )
      .annotate(SuccessDescription, "The organization's leases"),
    HttpApiEndpoint.get("resource", "/resource", {
      params: OrgParams,
      query: { resourceId: Schema.String },
      success: ResourceLeaseLookup,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one resource's lease")
      .annotate(
        OpenApi.Description,
        "The (unique) lease on a resource, whatever its status, or null.",
      )
      .annotate(SuccessDescription, "The resource's lease, or null")
      .annotate(InvalidRequestMessage, "Missing resourceId"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ResourceLeaseCreate,
      success: ResourceLease.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, NotFound, LeaseConflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a resource lease")
      .annotate(
        OpenApi.Description,
        "Attach an expiry to a resource; 'give me a test cluster for 3 days'. One lease per " +
          "resource (an active lease conflicts; a terminal one is replaced). `autoDelete: true` " +
          "opts into deletion at expiry; the poller announces it twice first, defers during " +
          "change freezes, and requires the caller to hold `resources:delete`. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created lease")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.put("update", "/:leaseId", {
      params: LeaseParams,
      payload: ResourceLeaseUpdate,
      success: ResourceLease,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a lease")
      .annotate(
        OpenApi.Description,
        "Edit the deadline, the auto-delete opt-in and/or the note of an active lease. " +
          "Changing the deadline or the auto-delete flag re-arms the two-announcement schedule. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated lease")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("cancel", "/:leaseId/cancel", {
      params: LeaseParams,
      success: ResourceLease,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Cancel a lease")
      .annotate(
        OpenApi.Description,
        "Stop the countdown; the resource stays, the lease goes `canceled` and leaves the " +
          "expiry radar. Audit-logged.",
      )
      .annotate(SuccessDescription, "The canceled lease"),
    HttpApiEndpoint.delete("delete", "/:leaseId", {
      params: LeaseParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a lease row")
      .annotate(
        OpenApi.Description,
        "Remove the lease record entirely (including terminal rows). The resource is not " +
          "touched. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/leases")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Resource leases") {}

export class LeasesApi extends withApiDefaults(HttpApi.make("leases").add(LeasesGroup)) {}

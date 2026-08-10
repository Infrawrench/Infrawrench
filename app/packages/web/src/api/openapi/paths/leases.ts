import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const LeaseStatus = z.enum(["active", "deleted", "failed", "canceled"]).openapi({
  description:
    "Lease lifecycle: `active` (counting down), `deleted` (auto-delete completed), " +
    "`failed` (auto-delete was retried and given up on — see `lastError`), or " +
    "`canceled` (called off; the resource stays).",
});

export function registerLeasePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const ResourceLease = strict({
    id: Uuid,
    resourceId: z.string().describe("Infrawrench resource id the lease is attached to."),
    accountId: Uuid,
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceName: z
      .string()
      .describe("Resource display name (denormalized at lease time, so it survives deletion)."),
    accountName: z.string(),
    expiresAt: IsoDateTime.describe("The lease deadline."),
    autoDelete: z
      .boolean()
      .describe(
        "Whether the resource is deleted at expiry. Auto-delete is announced twice before it " +
          "fires and deferred while an org change freeze is in effect.",
      ),
    note: z.string().nullable().describe("Why/who-for; shown on the expiry radar."),
    status: LeaseStatus,
    firstWarningAt: IsoDateTime.nullable().describe(
      "When the first auto-delete announcement went out; null until sent.",
    ),
    finalWarningAt: IsoDateTime.nullable().describe(
      "When the final auto-delete announcement went out; null until sent.",
    ),
    deleteAttempts: z.number().int(),
    lastError: z
      .string()
      .nullable()
      .describe("Last auto-delete failure or freeze-deferral detail; never silent."),
    completedAt: IsoDateTime.nullable().describe("When the lease reached a terminal status."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("ResourceLease");

  const ResourceLeaseList = strict({
    leases: z.array(ResourceLease),
  }).openapi("ResourceLeaseList");

  const ResourceLeaseCreate = strict({
    resourceId: z.string(),
    accountId: Uuid,
    expiresAt: IsoDateTime.describe("Must be in the future, at most 365 days out."),
    autoDelete: z
      .boolean()
      .optional()
      .describe("Requires the `resources:delete` permission when true."),
    note: z.string().max(500).optional(),
  }).openapi("ResourceLeaseCreate");

  const ResourceLeaseUpdate = strict({
    expiresAt: IsoDateTime.optional(),
    autoDelete: z
      .boolean()
      .optional()
      .describe("Requires the `resources:delete` permission when set to true."),
    note: z.string().max(500).nullable().optional().describe("`null` clears the note."),
  }).openapi("ResourceLeaseUpdate");

  const ResourceLeaseLookup = strict({
    lease: ResourceLease.nullable(),
  }).openapi("ResourceLeaseLookup");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/leases",
    tags: ["Resource leases"],
    summary: "List resource leases",
    description:
      "Every lease in the organization, soonest deadline first. Active leases also appear on " +
      "the expiry radar (`GET /expiring`) as kind `lease` items, so the owner is nagged " +
      "through the existing expiry alerts.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's leases",
        content: { "application/json": { schema: ResourceLeaseList } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/leases/resource",
    tags: ["Resource leases"],
    summary: "Get one resource's lease",
    description: "The (unique) lease on a resource, whatever its status, or null.",
    request: {
      params: OrgIdParam,
      query: strict({ resourceId: z.string() }),
    },
    responses: {
      200: {
        description: "The resource's lease, or null",
        content: { "application/json": { schema: ResourceLeaseLookup } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/leases",
    tags: ["Resource leases"],
    summary: "Create a resource lease",
    description:
      "Attach an expiry to a resource — 'give me a test cluster for 3 days'. One lease per " +
      "resource (an active lease conflicts; a terminal one is replaced). `autoDelete: true` " +
      "opts into deletion at expiry — the poller announces it twice first, defers during " +
      "change freezes, and requires the caller to hold `resources:delete`. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ResourceLeaseCreate } } },
    },
    responses: {
      201: {
        description: "The created lease",
        content: { "application/json": { schema: ResourceLease } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "The resource already has an active lease",
        content: {
          "application/json": { schema: strict({ error: z.string() }).openapi("LeaseConflict") },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/leases/{leaseId}",
    tags: ["Resource leases"],
    summary: "Update a lease",
    description:
      "Edit the deadline, the auto-delete opt-in and/or the note of an active lease. " +
      "Changing the deadline or the auto-delete flag re-arms the two-announcement schedule. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam.extend({ leaseId: Uuid }),
      body: { content: { "application/json": { schema: ResourceLeaseUpdate } } },
    },
    responses: {
      200: {
        description: "The updated lease",
        content: { "application/json": { schema: ResourceLease } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/leases/{leaseId}/cancel",
    tags: ["Resource leases"],
    summary: "Cancel a lease",
    description:
      "Stop the countdown — the resource stays, the lease goes `canceled` and leaves the " +
      "expiry radar. Audit-logged.",
    request: { params: OrgIdParam.extend({ leaseId: Uuid }) },
    responses: {
      200: {
        description: "The canceled lease",
        content: { "application/json": { schema: ResourceLease } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/leases/{leaseId}",
    tags: ["Resource leases"],
    summary: "Delete a lease row",
    description:
      "Remove the lease record entirely (including terminal rows). The resource is not " +
      "touched. Audit-logged.",
    request: { params: OrgIdParam.extend({ leaseId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });
}

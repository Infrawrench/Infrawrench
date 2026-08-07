import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerOwnershipPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const ResourceOwnership = strict({
    id: Uuid,
    resourceId: z.string(),
    accountId: Uuid,
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceName: z
      .string()
      .describe("Resource display name, denormalized so a report can name a deleted resource."),
    ownerUserId: Uuid.nullable().describe(
      "The routable owner — an org member. Alerts about this resource reach them.",
    ),
    ownerName: z.string().nullable().describe("Resolved server-side; null when unset or removed."),
    ownerEmail: z.string().nullable(),
    ownerLabel: z
      .string()
      .nullable()
      .describe("Free-text owner (a team, a rota, a contractor). Display-only, never routed."),
    purpose: z.string().nullable().describe("What this resource is for."),
    ticketUrl: z.string().nullable().describe("Link to the ticket that authorized it."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("ResourceOwnership");

  const ResourceOwnershipList = strict({
    ownership: z.array(ResourceOwnership),
  }).openapi("ResourceOwnershipListResponse");

  const ResourceOwnershipEnvelope = strict({
    ownership: ResourceOwnership.nullable(),
  }).openapi("ResourceOwnershipEnvelope");

  const OwnerCandidate = strict({
    userId: Uuid,
    name: z.string().describe("Display name, falling back to the email."),
    email: z.string(),
  }).openapi("OwnerCandidate");

  const OwnerCandidateList = strict({
    members: z.array(OwnerCandidate),
  }).openapi("OwnerCandidateListResponse");

  const ResourceOwnershipPatch = strict({
    resourceId: z.string(),
    ownerUserId: Uuid.nullable().optional().describe("Omit to keep, null to clear."),
    ownerLabel: z.string().nullable().optional().describe("Omit to keep, null to clear."),
    purpose: z.string().nullable().optional().describe("Omit to keep, null to clear."),
    ticketUrl: z.string().nullable().optional().describe("Omit to keep, null to clear."),
  }).openapi("ResourceOwnershipPatch");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ownership",
    tags: ["Ownership"],
    summary: "List resource ownership records",
    description:
      "Every ownership record in the organization — owner, purpose and authorizing ticket, per " +
      "resource. Only resources somebody has recorded something about appear; an absent record " +
      "means the resource is unowned.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's ownership records",
        content: { "application/json": { schema: ResourceOwnershipList } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ownership/members",
    tags: ["Ownership"],
    summary: "List people an owner can be set to",
    description:
      "Org members, as a minimal id/name/email projection for the owner picker. Requires only " +
      "`resources:read`, deliberately not `team:read`: recording who owns a resource must not " +
      "be reserved for whoever can also read roles and membership.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Members an owner can be set to",
        content: { "application/json": { schema: OwnerCandidateList } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ownership/resource",
    tags: ["Ownership"],
    summary: "Get one resource's ownership",
    description: "The ownership record for a single resource, or null when none is recorded.",
    request: {
      params: OrgIdParam,
      query: z.object({ resourceId: z.string() }),
    },
    responses: {
      200: {
        description: "The resource's ownership, or null",
        content: { "application/json": { schema: ResourceOwnershipEnvelope } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/ownership",
    tags: ["Ownership"],
    summary: "Set a resource's ownership",
    description:
      "Upsert keyed by `resourceId` — ownership is a property of the resource, so there is no " +
      "separate create and update. Omitted fields keep their value and `null` clears one. " +
      "Clearing every field removes the record entirely and the response is `null`, which is " +
      "the new truth rather than an empty record. An `ownerUserId` must be a member of this " +
      "organization: ownership that looks routable but reaches nobody is worse than none.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ResourceOwnershipPatch } } },
    },
    responses: {
      200: {
        description: "The saved record, or null when nothing was left to record",
        content: { "application/json": { schema: ResourceOwnership.nullable() } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/ownership",
    tags: ["Ownership"],
    summary: "Clear a resource's ownership",
    description: "Removes the ownership record. The resource itself is untouched.",
    request: {
      params: OrgIdParam,
      query: z.object({ resourceId: z.string() }),
    },
    responses: {
      204: { description: "Ownership cleared" },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}

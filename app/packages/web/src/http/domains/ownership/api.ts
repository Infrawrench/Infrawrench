/**
 * Resource ownership: `/api/org/:orgId/ownership`, the endpoint definitions.
 *
 * Owner, purpose, and the authorizing ticket, on any resource. Permissions
 * follow the leases stance: reads are `resources:read` (ownership is a view
 * over the org's resource set), writes `resources:write`. Deliberately *not*
 * gated on an org-admin permission: the person who can create a resource is
 * the person who should be able to say it is theirs, and requiring an admin
 * to record ownership is how ownership data stops existing.
 *
 * The write body is documented here and checked by hand in the handler, whose
 * 400s name the field at fault, so that endpoint is served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

export const ResourceOwnership = Schema.Struct({
  id: Uuid,
  resourceId: Schema.String,
  accountId: Uuid,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceName: Schema.String.annotate({
    description: "Resource display name, denormalized so a report can name a deleted resource.",
  }),
  ownerUserId: Schema.NullOr(Uuid).annotate({
    description: "The routable owner; an org member. Alerts about this resource reach them.",
  }),
  ownerName: Schema.NullOr(Schema.String).annotate({
    description: "Resolved server-side; null when unset or removed.",
  }),
  ownerEmail: Schema.NullOr(Schema.String),
  ownerLabel: Schema.NullOr(Schema.String).annotate({
    description: "Free-text owner (a team, a rota, a contractor). Display-only, never routed.",
  }),
  purpose: Schema.NullOr(Schema.String).annotate({ description: "What this resource is for." }),
  ticketUrl: Schema.NullOr(Schema.String).annotate({
    description: "Link to the ticket that authorized it.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ResourceOwnership" });

export const ResourceOwnershipListResponse = Schema.Struct({
  ownership: Schema.Array(ResourceOwnership),
}).annotate({ identifier: "ResourceOwnershipListResponse" });

export const ResourceOwnershipEnvelope = Schema.Struct({
  ownership: Schema.NullOr(ResourceOwnership),
}).annotate({ identifier: "ResourceOwnershipEnvelope" });

const OwnerCandidate = Schema.Struct({
  userId: Uuid,
  name: Schema.String.annotate({ description: "Display name, falling back to the email." }),
  email: Schema.String,
}).annotate({ identifier: "OwnerCandidate" });

export const OwnerCandidateListResponse = Schema.Struct({
  members: Schema.Array(OwnerCandidate),
}).annotate({ identifier: "OwnerCandidateListResponse" });

const keepOrClear = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.NullOr(schema).annotate({ description: "Omit to keep, null to clear." }),
  );

const ResourceOwnershipPatch = Schema.Struct({
  resourceId: Schema.String,
  ownerUserId: keepOrClear(Uuid),
  ownerLabel: keepOrClear(Schema.String),
  purpose: keepOrClear(Schema.String),
  ticketUrl: keepOrClear(Schema.String),
}).annotate({ identifier: "ResourceOwnershipPatch" });

export const SavedOwnership = Schema.NullOr(ResourceOwnership);

const ResourceQuery = { resourceId: Schema.String } as const;

export class OwnershipGroup extends HttpApiGroup.make("ownership")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: ResourceOwnershipListResponse })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List resource ownership records")
      .annotate(
        OpenApi.Description,
        "Every ownership record in the organization; owner, purpose and authorizing ticket, per " +
          "resource. Only resources somebody has recorded something about appear; an absent record " +
          "means the resource is unowned.",
      )
      .annotate(SuccessDescription, "The organization's ownership records"),
    HttpApiEndpoint.get("members", "/members", {
      params: OrgParams,
      success: OwnerCandidateListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List people an owner can be set to")
      .annotate(
        OpenApi.Description,
        "Org members, as a minimal id/name/email projection for the owner picker. Requires only " +
          "`resources:read`, deliberately not `team:read`: recording who owns a resource must not " +
          "be reserved for whoever can also read roles and membership.",
      )
      .annotate(SuccessDescription, "Members an owner can be set to"),
    HttpApiEndpoint.get("resource", "/resource", {
      params: OrgParams,
      query: ResourceQuery,
      success: ResourceOwnershipEnvelope,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one resource's ownership")
      .annotate(
        OpenApi.Description,
        "The ownership record for a single resource, or null when none is recorded.",
      )
      .annotate(SuccessDescription, "The resource's ownership, or null")
      .annotate(InvalidRequestMessage, "Missing resourceId"),
    HttpApiEndpoint.put("set", "/", {
      params: OrgParams,
      payload: ResourceOwnershipPatch,
      success: SavedOwnership,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Set a resource's ownership")
      .annotate(
        OpenApi.Description,
        "Upsert keyed by `resourceId`: ownership is a property of the resource, so there is no " +
          "separate create and update. Omitted fields keep their value and `null` clears one. " +
          "Clearing every field removes the record entirely and the response is `null`, which is " +
          "the new truth rather than an empty record. An `ownerUserId` must be a member of this " +
          "organization: ownership that looks routable but reaches nobody is worse than none.",
      )
      .annotate(SuccessDescription, "The saved record, or null when nothing was left to record")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("clear", "/", {
      params: OrgParams,
      query: ResourceQuery,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Clear a resource's ownership")
      .annotate(
        OpenApi.Description,
        "Removes the ownership record. The resource itself is untouched.",
      )
      .annotate(SuccessDescription, "Ownership cleared")
      .annotate(InvalidRequestMessage, "Missing resourceId"),
  )
  .prefix("/api/org/:orgId/ownership")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Ownership") {}

export class OwnershipApi extends withApiDefaults(HttpApi.make("ownership").add(OwnershipGroup)) {}

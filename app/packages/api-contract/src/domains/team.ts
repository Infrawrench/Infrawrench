/**
 * Team: `/api/org/:orgId/team`, the endpoint definitions. Roles, members and
 * invitations in this organization, and the caller's own effective access.
 *
 * The request bodies are documented here and read raw by the handlers, which
 * keep their own refusals (a blank name, an unknown role) and the escalation
 * and owner guards, in the order the routes always applied them.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound, PaymentRequired } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Email, IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { CostVisibilitySummary } from "../http/schemas/cost-visibility";
import { OrganizationRole, Permission } from "../http/schemas/permissions";

const message = Schema.String.annotate({ description: "Human-readable error message" });

/** A refused edit of a system role. */
export class TeamUnprocessable extends Schema.Error<TeamUnprocessable>(
  "infrawrench/http/team/Unprocessable",
)({ error: message }, { httpApiStatus: 422, identifier: "Error" }) {}

/** Buying the extra seat failed, so the invitation was not sent. */
export class SeatPurchaseFailed extends Schema.Error<SeatPurchaseFailed>(
  "infrawrench/http/team/SeatPurchaseFailed",
)({ error: message }, { httpApiStatus: 502, identifier: "Error" }) {}

/** Every seat is taken; the client offers to buy one and retries with `addSeat`. */
export class SeatLimitReached extends Schema.Error<SeatLimitReached>(
  "infrawrench/http/team/SeatLimitReached",
)(
  {
    error: Schema.String,
    code: Schema.Literal("seat_limit_reached"),
    seatCount: Schema.Int.annotate({
      description: "Total capacity: monthly subscription seats plus prepaid capacity-slot seats",
    }),
    seatsUsed: Schema.Int.annotate({ description: "Members plus pending unexpired invitations" }),
    canAddSeat: Schema.Boolean.annotate({
      description:
        "Whether retrying with `addSeat: true` can succeed. False when the org's capacity is entirely prepaid capacity slots: there is no monthly seat to buy, so the only remedy is another capacity slot.",
    }),
  },
  { httpApiStatus: 409, identifier: "SeatLimitResponse" },
) {}

const roleSummaryFields = {
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  isSystem: Schema.Boolean,
  systemKey: Schema.NullOr(Schema.String),
};

const RoleSummary = Schema.Struct(roleSummaryFields).annotate({ identifier: "RoleSummary" });

export const Role = Schema.Struct({
  ...roleSummaryFields,
  permissions: Schema.Array(Permission),
}).annotate({ identifier: "Role" });

const RoleCreateRequest = Schema.Struct({
  name: Schema.String.check(minLength(1)),
  description: Schema.optionalKey(Schema.String),
  permissions: Schema.Array(Permission),
}).annotate({ identifier: "RoleCreateRequest" });

const RoleUpdateRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  permissions: Schema.optionalKey(Schema.Array(Permission)),
}).annotate({ identifier: "RoleUpdateRequest" });

export const OrgMember = Schema.Struct({
  id: Uuid,
  email: Email,
  displayName: Schema.NullOr(Schema.String),
  role: OrganizationRole,
  roleId: Schema.NullOr(Uuid),
  roleName: Schema.NullOr(Schema.String),
  roleSystemKey: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "OrgMember" });

export const Invitation = Schema.Struct({
  id: Uuid,
  email: Email,
  role: OrganizationRole,
  roleId: Schema.NullOr(Uuid),
  roleName: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(IsoDateTime),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
}).annotate({ identifier: "Invitation" });

const InviteRequest = Schema.Struct({
  email: Email,
  role: Schema.optionalKey(OrganizationRole),
  roleId: Schema.optionalKey(Uuid),
  addSeat: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When the paid plan is full (409 seat_limit_reached), retry with this set to buy one more monthly seat and send the invitation. Requires billing:write. Only works when the 409 reported `canAddSeat: true`: an org whose capacity is entirely prepaid capacity slots has no monthly seat to add.",
    }),
  ),
}).annotate({ identifier: "InviteRequest" });

export const InviteResponse = Schema.Struct({ id: Uuid, token: Schema.String }).annotate({
  identifier: "InviteResponse",
});

const RoleChangeRequest = Schema.Struct({
  role: Schema.optionalKey(OrganizationRole),
  roleId: Schema.optionalKey(Uuid),
}).annotate({ identifier: "RoleChangeRequest" });

export const MeResponse = Schema.Struct({
  userId: Schema.String,
  email: Email,
  role: Schema.NullOr(RoleSummary),
  permissions: Schema.Array(Permission),
  costVisibility: Schema.optionalKey(CostVisibilitySummary),
}).annotate({ identifier: "MeResponse" });

export const PermissionCatalog = Schema.Struct({ permissions: Schema.Array(Permission) }).annotate({
  identifier: "PermissionCatalog",
});

export class TeamGroup extends HttpApiGroup.make("team")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      params: OrgParams,
      success: MeResponse,
    })
      .annotate(OpenApi.Summary, "Current user's effective permissions and role")
      .annotate(SuccessDescription, "Permissions"),
    HttpApiEndpoint.get("permissions", "/permissions", {
      params: OrgParams,
      success: PermissionCatalog,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List all permission strings the server recognises")
      .annotate(SuccessDescription, "Catalog"),
    HttpApiEndpoint.get("listRoles", "/roles", {
      params: OrgParams,
      success: Schema.Array(Role),
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List roles (system + custom)")
      .annotate(SuccessDescription, "Roles"),
    HttpApiEndpoint.post("createRole", "/roles", {
      params: OrgParams,
      payload: RoleCreateRequest,
      success: Role,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "team:role:write")
      .annotate(OpenApi.Summary, "Create a custom role")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.patch("updateRole", "/roles/:id", {
      params: OrgIdParams,
      payload: RoleUpdateRequest,
      success: Role,
      error: [BadRequest, Forbidden, NotFound, TeamUnprocessable],
    })
      .annotate(RequiredPermission, "team:role:write")
      .annotate(OpenApi.Summary, "Edit a custom role")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteRole", "/roles/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, Conflict, TeamUnprocessable],
    })
      .annotate(RequiredPermission, "team:role:write")
      .annotate(
        OpenApi.Summary,
        "Delete a custom role (must have no members or pending invitations)",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("listMembers", "/members", {
      params: OrgParams,
      success: Schema.Array(OrgMember),
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List org members")
      .annotate(SuccessDescription, "Members"),
    HttpApiEndpoint.get("listInvitations", "/invitations", {
      params: OrgParams,
      success: Schema.Array(Invitation),
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List pending and historical invitations")
      .annotate(SuccessDescription, "Invitations"),
    HttpApiEndpoint.post("invite", "/invitations", {
      params: OrgParams,
      payload: InviteRequest,
      success: InviteResponse,
      error: [
        BadRequest,
        PaymentRequired,
        Forbidden,
        NotFound,
        SeatLimitReached,
        SeatPurchaseFailed,
      ],
    })
      .annotate(RequiredPermission, "team:invite")
      .annotate(OpenApi.Summary, "Create an invitation (token valid for 7 days)")
      .annotate(SuccessDescription, "Invited"),
    HttpApiEndpoint.delete("removeMember", "/members/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Remove a member from the org")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.patch("changeMemberRole", "/members/:id/role", {
      params: OrgIdParams,
      payload: RoleChangeRequest,
      success: Ok,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "team:role:write")
      .annotate(OpenApi.Summary, "Change a member's role")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("revokeInvitation", "/invitations/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "team:invite")
      .annotate(OpenApi.Summary, "Revoke a pending invitation")
      .annotate(SuccessDescription, "Revoked"),
  )
  .prefix("/api/org/:orgId/team")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Team") {}

export class TeamApi extends withApiDefaults(HttpApi.make("team").add(TeamGroup)) {}

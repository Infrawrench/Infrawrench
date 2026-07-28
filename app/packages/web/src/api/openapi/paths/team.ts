import { z } from "../zod";
import {
  strict,
  ErrorResponse,
  ErrorResponses,
  Uuid,
  Ok,
  OrgIdParam,
  Email,
  Role,
  IsoDateTime,
  Permission,
} from "../common";
import type { BuildContext } from "../context";

const RoleSummary = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  systemKey: z.string().nullable(),
}).openapi("RoleSummary");

const RoleDetail = RoleSummary.extend({
  permissions: z.array(Permission),
}).openapi("Role");

const RoleCreateRequest = strict({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(Permission),
}).openapi("RoleCreateRequest");

const RoleUpdateRequest = strict({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  permissions: z.array(Permission).optional(),
}).openapi("RoleUpdateRequest");

const Member = strict({
  id: Uuid,
  email: Email,
  displayName: z.string().nullable(),
  role: Role,
  roleId: Uuid.nullable(),
  roleName: z.string().nullable(),
  roleSystemKey: z.string().nullable(),
  createdAt: IsoDateTime,
}).openapi("OrgMember");

const Invitation = strict({
  id: Uuid,
  email: Email,
  role: Role,
  roleId: Uuid.nullable(),
  roleName: z.string().nullable(),
  acceptedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
}).openapi("Invitation");

const InviteRequest = strict({
  email: Email,
  role: Role.optional(),
  roleId: Uuid.optional(),
  addSeat: z.boolean().optional().openapi({
    description:
      "When the paid plan is full (409 seat_limit_reached), retry with this set to buy one more seat and send the invitation. Requires billing:write.",
  }),
}).openapi("InviteRequest");
const InviteResponse = strict({ id: Uuid, token: z.string() }).openapi("InviteResponse");

const SeatLimitResponse = strict({
  error: z.string(),
  code: z.literal("seat_limit_reached"),
  seatCount: z.number().int().openapi({ description: "Seats on the plan" }),
  seatsUsed: z
    .number()
    .int()
    .openapi({ description: "Members plus pending unexpired invitations" }),
}).openapi("SeatLimitResponse");

const RoleChangeRequest = strict({
  role: Role.optional(),
  roleId: Uuid.optional(),
}).openapi("RoleChangeRequest");

const MeResponse = strict({
  userId: z.string(),
  email: Email,
  role: RoleSummary.nullable(),
  permissions: z.array(Permission),
}).openapi("MeResponse");

const PermissionCatalog = strict({ permissions: z.array(Permission) }).openapi("PermissionCatalog");

export function registerTeamPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParams = OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/team/me",
    tags: ["Team"],
    summary: "Current user's effective permissions and role",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Permissions", content: { "application/json": { schema: MeResponse } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/team/permissions",
    tags: ["Team"],
    summary: "List all permission strings the server recognises",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Catalog",
        content: { "application/json": { schema: PermissionCatalog } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/team/roles",
    tags: ["Team"],
    summary: "List roles (system + custom)",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Roles",
        content: { "application/json": { schema: z.array(RoleDetail) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/team/roles",
    tags: ["Team"],
    summary: "Create a custom role",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: RoleCreateRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: RoleDetail } } },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/team/roles/{id}",
    tags: ["Team"],
    summary: "Edit a custom role",
    request: {
      params: idParams,
      body: { content: { "application/json": { schema: RoleUpdateRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: RoleDetail } } },
      404: ErrorResponses[404],
      422: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/team/roles/{id}",
    tags: ["Team"],
    summary: "Delete a custom role (must have no members or pending invitations)",
    request: { params: idParams },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
      422: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/team/members",
    tags: ["Team"],
    summary: "List org members",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Members", content: { "application/json": { schema: z.array(Member) } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/team/invitations",
    tags: ["Team"],
    summary: "List pending and historical invitations",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Invitations",
        content: { "application/json": { schema: z.array(Invitation) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/team/invitations",
    tags: ["Team"],
    summary: "Create an invitation (token valid for 7 days)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: InviteRequest } }, required: true },
    },
    responses: {
      200: { description: "Invited", content: { "application/json": { schema: InviteResponse } } },
      409: {
        description: "All seats are in use; retry with addSeat to buy one more",
        content: { "application/json": { schema: SeatLimitResponse } },
      },
      502: {
        description: "Buying the extra seat failed; the invitation was not sent",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/team/members/{id}",
    tags: ["Team"],
    summary: "Remove a member from the org",
    request: { params: idParams },
    responses: { 200: { description: "Removed", content: { "application/json": { schema: Ok } } } },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/team/members/{id}/role",
    tags: ["Team"],
    summary: "Change a member's role",
    request: {
      params: idParams,
      body: { content: { "application/json": { schema: RoleChangeRequest } }, required: true },
    },
    responses: { 200: { description: "Updated", content: { "application/json": { schema: Ok } } } },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/team/invitations/{id}",
    tags: ["Team"],
    summary: "Revoke a pending invitation",
    request: { params: idParams },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}

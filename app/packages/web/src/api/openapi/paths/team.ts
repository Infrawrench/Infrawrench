import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam, Email, Role, IsoDateTime } from "../common";
import type { BuildContext } from "../index";

const Member = strict({
  id: Uuid,
  email: Email,
  displayName: z.string().nullable(),
  role: Role,
  createdAt: IsoDateTime,
}).openapi("OrgMember");

const Invitation = strict({
  id: Uuid,
  email: Email,
  role: Role,
  acceptedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
}).openapi("Invitation");

const InviteRequest = strict({ email: Email, role: Role }).openapi("InviteRequest");
const InviteResponse = strict({ id: Uuid, token: z.string() }).openapi("InviteResponse");

const RoleChangeRequest = strict({ role: Role }).openapi("RoleChangeRequest");

export function registerTeamPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParams = OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

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

import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Email, Role, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

const InvitationDetail = strict({
  id: Uuid,
  email: Email,
  role: Role,
  expiresAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
  organizationId: Uuid,
  organizationName: z.string(),
}).openapi("InvitationDetail");

const AcceptRequest = strict({ token: z.string() }).openapi("AcceptInvitationRequest");
const AcceptResponse = strict({
  organization: strict({ id: Uuid, displayName: z.string() }),
}).openapi("AcceptInvitationResponse");

export function registerInvitationPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/invitations/by-token/{token}",
    tags: ["Invitations"],
    summary: "Get invitation details by token",
    request: {
      params: strict({ token: z.string().openapi({ param: { name: "token", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Invitation",
        content: { "application/json": { schema: InvitationDetail } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/invitations/accept",
    tags: ["Invitations"],
    summary: "Accept an invitation",
    request: {
      body: { content: { "application/json": { schema: AcceptRequest } }, required: true },
    },
    responses: {
      200: { description: "Accepted", content: { "application/json": { schema: AcceptResponse } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  // Re-export Ok for convenience to ensure it's referenced somewhere; harmless.
  void Ok;
}

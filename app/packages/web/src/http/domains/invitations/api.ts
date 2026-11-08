/**
 * Accepting an invitation: `/api/invitations`, the endpoint definitions.
 *
 * Session-only. Accepting is what binds a membership: the invitation's email
 * must be the caller's, and verified with WorkOS.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { SessionAuth } from "../../middleware-tags";
import { Email, IsoDate, Uuid } from "../../schemas/common";
import { OrganizationRole } from "../../schemas/permissions";

export const InvitationDetail = Schema.Struct({
  id: Uuid,
  email: Email,
  role: OrganizationRole,
  expiresAt: IsoDate,
  acceptedAt: Schema.NullOr(IsoDate),
  organizationId: Uuid,
  organizationName: Schema.String,
}).annotate({ identifier: "InvitationDetail" });

const AcceptInvitationRequest = Schema.Struct({ token: Schema.String }).annotate({
  identifier: "AcceptInvitationRequest",
});

export const AcceptInvitationResponse = Schema.Struct({
  organization: Schema.Struct({ id: Uuid, displayName: Schema.String }),
}).annotate({ identifier: "AcceptInvitationResponse" });

export class InvitationsGroup extends HttpApiGroup.make("invitations")
  .add(
    HttpApiEndpoint.get("byToken", "/by-token/:token", {
      params: { token: Schema.String },
      success: InvitationDetail,
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "Get invitation details by token")
      .annotate(SuccessDescription, "Invitation"),
    HttpApiEndpoint.post("accept", "/accept", {
      payload: AcceptInvitationRequest,
      success: AcceptInvitationResponse,
      error: [BadRequest, Forbidden],
    })
      .annotate(OpenApi.Summary, "Accept an invitation")
      .annotate(SuccessDescription, "Accepted"),
  )
  .prefix("/api/invitations")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Invitations") {}

export class InvitationsApi extends withApiDefaults(
  HttpApi.make("invitations").add(InvitationsGroup),
) {}

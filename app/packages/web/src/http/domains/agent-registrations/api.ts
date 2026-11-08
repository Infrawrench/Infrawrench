/**
 * Agent registrations: `/api/org/:orgId/agent-registrations`, the endpoint
 * definitions. The agents acting in an organization (trial, service and
 * platform agents), listed, edited and revoked from Settings → Agents.
 *
 * Gated on `team:read` / `team:invite` rather than a permission of its own: a
 * registration is a member of the organization in every sense that matters to
 * a reader of this page. Agent credentials cannot revoke registrations
 * (`AGENT_DENY_RULES`, which applies by path).
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import {
  BadRequest,
  Conflict,
  Forbidden,
  InternalServerError,
  NotFound,
  PaymentRequired,
  ServiceUnavailable,
  Unauthorized,
} from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PatchPlatformAgent, PlatformAgentEnvelope } from "../../schemas/zod-components";

/** Every status the hand-written spec listed for these operations. */
const DocumentedErrors = [
  BadRequest,
  Unauthorized,
  PaymentRequired,
  Forbidden,
  NotFound,
  Conflict,
  InternalServerError,
  ServiceUnavailable,
] as const;

export const AgentRegistration = Schema.Struct({
  id: Uuid,
  label: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["anonymous", "service_auth", "platform"]),
  prefix: Schema.NullOr(Schema.String).annotate({
    description: "First 8 characters of the credential.",
  }),
  claimedAt: Schema.NullOr(IsoDateTime),
  claimedByUserId: Schema.NullOr(Schema.String),
  claimedByEmail: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  linkId: Schema.NullOr(Uuid).annotate({
    description: "The platform link that made this agent (`kind: platform`), else null.",
  }),
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "The platform's own id for it.",
  }),
  scopes: Schema.NullOr(Schema.Array(Schema.String)).annotate({
    description: "Platform agents only: the scopes granted, before provider narrowing.",
  }),
  providers: Schema.NullOr(Schema.Array(Schema.String)).annotate({
    description: "Platform agents only: plugin ids its scopes are narrowed to. Empty means all.",
  }),
}).annotate({ identifier: "AgentRegistration" });

export const AgentRevoked = Schema.Struct({
  ok: Schema.Literal(true),
  revoked: Schema.Boolean.annotate({
    description:
      "False when the registration was already revoked. The request still succeeds (revocation " +
      "is idempotent) but nothing changed.",
  }),
}).annotate({ identifier: "AgentRevoked" });

export { PlatformAgentEnvelope };

/** The edit's 409, described as the hand-written spec had it. */
const revokedConflict = (operation: Record<string, unknown>): Record<string, unknown> => {
  const responses = operation["responses"];
  if (!Predicate.isObject(responses)) return operation;
  const conflict = responses["409"];
  if (!Predicate.isObject(conflict)) return operation;
  return {
    ...operation,
    responses: {
      ...responses,
      "409": { ...conflict, description: "The agent or its link has been revoked" },
    },
  };
};

export class AgentRegistrationsGroup extends HttpApiGroup.make("agentRegistrations")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(AgentRegistration),
      error: DocumentedErrors,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List the agent registrations acting in this organization")
      .annotate(SuccessDescription, "Registrations"),
    HttpApiEndpoint.patch("update", "/:id", {
      params: OrgIdParams,
      payload: PatchPlatformAgent,
      success: PlatformAgentEnvelope,
      error: DocumentedErrors,
    })
      .annotate(RequiredPermission, "team:invite")
      .annotate(OpenApi.Summary, "Edit a platform agent's label, scopes or providers")
      .annotate(
        OpenApi.Description,
        "Platform agents only (`kind: platform`). Scopes must be within the link's current " +
          "ceiling, and you may only add scopes you hold yourself. Closed to agent credentials.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(OpenApi.Transform, (operation) => revokedConflict(optionalRequestBody(operation))),
    HttpApiEndpoint.delete("revoke", "/:id", {
      params: OrgIdParams,
      success: AgentRevoked,
      error: DocumentedErrors,
    })
      .annotate(RequiredPermission, "team:invite")
      .annotate(OpenApi.Summary, "Revoke an agent registration")
      .annotate(
        OpenApi.Description,
        "The row is kept so audit entries naming this agent stay legible; its credential stops " +
          "working on the next request. Closed to agent credentials.",
      )
      .annotate(SuccessDescription, "Revoked"),
  )
  .prefix("/api/org/:orgId/agent-registrations")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Agent auth") {}

export class AgentRegistrationsApi extends withApiDefaults(
  HttpApi.make("agentRegistrations").add(AgentRegistrationsGroup),
) {}

/**
 * Agent links on the org tree: `/api/org/:orgId/agent-links`, the endpoint
 * definitions. The platforms linked to an organization, for Settings → Agents.
 *
 * Gated like agent registrations and for the same reason: `team:read` to see
 * them, `team:invite` to cut one off, since a link is a standing door for
 * agents into the org and revoking it is the same class of act as removing a
 * member. Agents cannot reach the mutation (`AGENT_DENY_RULES`, by path).
 *
 * The device flow, the approval and the link-authenticated routes
 * (`/api/agent-links/requests`, `/api/agent-link`) are not here: they are
 * public or session routes, the `agent-link-platform` domain, whose
 * components (`http/schemas/agent-links.ts`) this file refers to by name.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import {
  BadRequest,
  Conflict,
  Forbidden,
  InternalServerError,
  NotFound,
  PaymentRequired,
  ServiceUnavailable,
  Unauthorized,
} from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { AgentLinkProvider, AgentLinkScopeGroup } from "../http/schemas/agent-links";

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

export const AgentLinkSummary = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  organizationName: Schema.String,
  platform: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(Schema.String).annotate({ description: "The ceiling as approved." }),
  effectiveScopes: Schema.Array(Schema.String).annotate({
    description:
      "The ceiling as it stands now: approved ∩ the approver's current role (no elevation) − " +
      "permissions no agent may hold. Agents can only be granted scopes from here.",
  }),
  narrowableScopes: Schema.Array(Schema.String).annotate({
    description:
      "The scopes in `effectiveScopes` that `providers` can limit (resources, secrets, object " +
      "storage). An agent given `providers` may hold only these; any other scope is a " +
      "`scope_not_allowed`, because it would stay organization-wide.",
  }),
  scopeGroups: Schema.Array(AgentLinkScopeGroup).annotate({
    description: "`effectiveScopes` grouped and labelled as the Infrawrench pickers show them.",
  }),
  providers: Schema.Array(AgentLinkProvider).annotate({
    description: "Plugins the organization has at least one connected account for.",
  }),
  approvedBy: Schema.NullOr(Schema.Struct({ email: Schema.String })),
  createdAt: IsoDateTime,
  credentialPrefix: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "AgentLinkSummary" });

export const AgentLinkRevoked = Schema.Struct({
  ok: Schema.Literal(true),
  revoked: Schema.Boolean,
}).annotate({ identifier: "AgentLinkRevoked" });

export class AgentLinksGroup extends HttpApiGroup.make("agentLinks")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(AgentLinkSummary),
      error: DocumentedErrors,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List the platforms linked to this organization")
      .annotate(SuccessDescription, "Links"),
    HttpApiEndpoint.delete("revoke", "/:id", {
      params: OrgIdParams,
      success: AgentLinkRevoked,
      error: DocumentedErrors,
    })
      .annotate(RequiredPermission, "team:invite")
      .annotate(OpenApi.Summary, "Revoke a platform link and every agent it made")
      .annotate(OpenApi.Description, "Closed to agent credentials.")
      .annotate(SuccessDescription, "Revoked"),
  )
  .prefix("/api/org/:orgId/agent-links")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Agent links") {}

export class AgentLinksApi extends withApiDefaults(
  HttpApi.make("agentLinks").add(AgentLinksGroup),
) {}

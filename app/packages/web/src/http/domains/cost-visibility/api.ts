/**
 * Cost visibility scopes: `/api/org/:orgId/cost-visibility`, the endpoint
 * definitions.
 *
 * Listing is `team:read`, like roles. Changing a scope depends on the
 * principal: a role or member scope needs `team:role:write`, while an API
 * key's own owner may also scope that key with `apikeys:write`. So the
 * handler owns the PUT/DELETE checks and the document states the common case.
 * The body is checked by hand with the sentences it always had, and is
 * documented here. The Terraform provider manages these scopes
 * (`infrawrench_cost_visibility_scope`), so component and property names stay
 * as the Zod spec published them.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { COST_VISIBILITY_LIMITS } from "@infrawrench/client-core";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { DocumentedPermission, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams } from "../../schemas/common";
import { CostVisibilityPrincipalKind } from "../../schemas/cost-visibility";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";

export const CostVisibilityScope = Schema.Struct({
  id: Schema.String,
  principalKind: CostVisibilityPrincipalKind,
  principalId: Schema.String.annotate({ description: "Role id, member user id, or API key id." }),
  principalLabel: Schema.NullOr(Schema.String).annotate({
    description: "Role name, member email or key name; null when the principal no longer exists.",
  }),
  costCentreIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
  savedFilterId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostVisibilityScope" });

export const CostVisibilityScopeInput = Schema.Struct({
  principalKind: CostVisibilityPrincipalKind,
  principalId: Schema.String.check(minLength(1)),
  costCentreIds: Schema.Array(Schema.String)
    .annotate({
      description: "Rows the allocation rules assign to these cost centres (or their children).",
    })
    .check(maxLength(COST_VISIBILITY_LIMITS.maxCostCentres)),
  accountIds: Schema.Array(Schema.String)
    .annotate({ description: "Rows on these connected accounts." })
    .check(maxLength(COST_VISIBILITY_LIMITS.maxAccounts)),
  savedFilterId: Schema.NullOr(Schema.String).annotate({
    description:
      "A saved filter ANDed onto the scope. With no centres and no accounts it decides alone; " +
      "a scope with nothing at all matches no rows.",
  }),
}).annotate({ identifier: "CostVisibilityScopeInput" });

export class CostVisibilityGroup extends HttpApiGroup.make("costVisibility")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Struct({ scopes: Schema.Array(CostVisibilityScope) }),
      error: Forbidden,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List cost visibility scopes")
      .annotate(
        OpenApi.Description,
        "Every scope narrowing which cost rows a role, member or API key can see. Scopes that apply to one caller are intersected.",
      )
      .annotate(SuccessDescription, "Scopes"),
    HttpApiEndpoint.put("upsert", "/", {
      params: OrgParams,
      payload: CostVisibilityScopeInput,
      success: CostVisibilityScope,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Create or replace a cost visibility scope")
      .annotate(
        OpenApi.Description,
        "Upserts the scope of one principal. Roles and members need `team:role:write`; an API key's owner may also scope their own key with `apikeys:write`. Owners cannot be scoped, and cost-scoped callers cannot change scopes.",
      )
      .annotate(SuccessDescription, "The stored scope")
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(DocumentedPermission, "team:role:write"),
    // `principalKind` is read as sent: an unknown one is the handler's own 400.
    HttpApiEndpoint.delete("remove", "/:principalKind/:principalId", {
      params: {
        orgId: OrgId,
        principalKind: documentedAs(CostVisibilityPrincipalKind),
        principalId: Schema.String,
      },
      success: Ok,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Remove a cost visibility scope")
      .annotate(SuccessDescription, "Removed")
      .annotate(DocumentedPermission, "team:role:write"),
  )
  .prefix("/api/org/:orgId/cost-visibility")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Team") {}

export class CostVisibilityApi extends withApiDefaults(
  HttpApi.make("costVisibility").add(CostVisibilityGroup),
) {}

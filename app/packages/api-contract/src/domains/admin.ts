/**
 * The platform-admin surface: `/api/admin`, the endpoint definitions.
 *
 * Session-authed, then gated by the INFRAWRENCH_PLATFORM_ADMIN_EMAILS
 * allowlist (`auth/platform-admin.ts`): these operate across all orgs, so org
 * membership and org roles don't apply here. Every path is in the public
 * spec's withheld list, so the operations are `x-internal`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { SessionAuth } from "../http/middleware-tags";
import { IsoDate } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";

export const AdminOrganization = Schema.Struct({
  id: Schema.String.annotate({ description: "WorkOS organization id" }),
  displayName: Schema.String,
  complimentary: Schema.Boolean,
  createdAt: IsoDate,
  memberCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  subscriptionStatus: Schema.NullOr(
    Schema.Literals(["trialing", "active", "past_due", "canceled", "unpaid"]),
  ).annotate({
    description: "Stripe subscription status, or null when the org never checked out",
  }),
}).annotate({ identifier: "AdminOrganization" });

const ComplimentaryUpdate = Schema.Struct({ complimentary: Schema.Boolean }).annotate({
  identifier: "ComplimentaryUpdate",
});

export const ComplimentaryResult = Schema.Struct({
  id: Schema.String,
  complimentary: Schema.Boolean,
}).annotate({ identifier: "ComplimentaryResult" });

const ALLOWLIST_NOTE =
  "Platform admins only (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist). 403 for everyone else.";

export class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listOrganizations", "/organizations", {
      success: Schema.Array(AdminOrganization),
      error: Forbidden,
    })
      .annotate(OpenApi.Summary, "List every organization with billing-relevant state")
      .annotate(OpenApi.Description, ALLOWLIST_NOTE)
      .annotate(SuccessDescription, "All organizations"),
    HttpApiEndpoint.put("setComplimentary", "/organizations/:orgId/complimentary", {
      params: { orgId: Schema.String.annotate({ description: "Organization id" }) },
      payload: ComplimentaryUpdate,
      success: ComplimentaryResult,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Grant or revoke complimentary (never-billed) access for an org")
      .annotate(
        OpenApi.Description,
        "Platform admins only (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist). Complimentary orgs get every paid perk, uncapped AI chat by default, and are never billed or reported to Stripe.",
      )
      .annotate(SuccessDescription, "Updated flag")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/admin")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Admin") {}

export class AdminApi extends withApiDefaults(HttpApi.make("admin").add(AdminGroup)) {}

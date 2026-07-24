import { z } from "../zod";
import { strict, ErrorResponses, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const AdminOrganization = strict({
  id: z.string().openapi({ description: "WorkOS organization id" }),
  displayName: z.string(),
  complimentary: z.boolean(),
  createdAt: IsoDateTime,
  memberCount: z.number().int().nonnegative(),
  subscriptionStatus: z
    .enum(["trialing", "active", "past_due", "canceled", "unpaid"])
    .nullable()
    .openapi({ description: "Stripe subscription status, or null when the org never checked out" }),
}).openapi("AdminOrganization");

const ComplimentaryUpdate = strict({
  complimentary: z.boolean(),
}).openapi("ComplimentaryUpdate");

const ComplimentaryResult = strict({
  id: z.string(),
  complimentary: z.boolean(),
}).openapi("ComplimentaryResult");

const AdminOrgIdParam = strict({
  orgId: z
    .string()
    .openapi({ param: { name: "orgId", in: "path" }, description: "Organization id" }),
});

export function registerAdminPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/admin/organizations",
    tags: ["Admin"],
    summary: "List every organization with billing-relevant state",
    description:
      "Platform admins only (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist). 403 for everyone else.",
    responses: {
      200: {
        description: "All organizations",
        content: { "application/json": { schema: z.array(AdminOrganization) } },
      },
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/admin/organizations/{orgId}/complimentary",
    tags: ["Admin"],
    summary: "Grant or revoke complimentary (never-billed) access for an org",
    description:
      "Platform admins only (INFRAWRENCH_PLATFORM_ADMIN_EMAILS allowlist). Complimentary orgs get every paid perk, uncapped AI chat by default, and are never billed or reported to Stripe.",
    request: {
      params: AdminOrgIdParam,
      body: {
        content: { "application/json": { schema: ComplimentaryUpdate } },
      },
    },
    responses: {
      200: {
        description: "Updated flag",
        content: { "application/json": { schema: ComplimentaryResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });
}

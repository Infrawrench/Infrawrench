import { z } from "../zod";
import { strict, OrgIdParam, IsoDateTime, Ok, ErrorResponses } from "../common";
import type { BuildContext } from "../context";

const PrincipalKind = z.enum(["role", "member", "api_key"]).openapi("CostVisibilityPrincipalKind", {
  description: "What a cost visibility scope attaches to.",
});

export const CostVisibilitySource = strict({
  kind: PrincipalKind,
  label: z.string().nullable(),
  costCentreIds: z.array(z.string()),
  accountIds: z.array(z.string()),
  savedFilterId: z.string().nullable(),
}).openapi("CostVisibilitySource");

export const CostVisibilitySummary = strict({
  restricted: z
    .boolean()
    .describe("False means the caller sees every cost row the organization holds."),
  sources: z
    .array(CostVisibilitySource)
    .describe("Every scope that applies to the caller. A cost row must match all of them."),
}).openapi("CostVisibilitySummary");

const CostVisibilityScope = strict({
  id: z.string(),
  principalKind: PrincipalKind,
  principalId: z.string().describe("Role id, member user id, or API key id."),
  principalLabel: z
    .string()
    .nullable()
    .describe("Role name, member email or key name; null when the principal no longer exists."),
  costCentreIds: z.array(z.string()),
  accountIds: z.array(z.string()),
  savedFilterId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CostVisibilityScope");

const CostVisibilityScopeInput = strict({
  principalKind: PrincipalKind,
  principalId: z.string().min(1),
  costCentreIds: z
    .array(z.string())
    .max(50)
    .describe("Rows the allocation rules assign to these cost centres (or their children)."),
  accountIds: z.array(z.string()).max(200).describe("Rows on these connected accounts."),
  savedFilterId: z
    .string()
    .nullable()
    .describe(
      "A saved filter ANDed onto the scope. With no centres and no accounts it decides alone; " +
        "a scope with nothing at all matches no rows.",
    ),
}).openapi("CostVisibilityScopeInput");

const ShareableObjectType = z
  .enum(["cost_report", "cost_report_folder", "dashboard", "cost_canvas"])
  .openapi("ShareableObjectType");
const AccessLevel = z.enum(["owner", "editor", "viewer"]).openapi("ObjectAccessLevel");
const OrgAccess = z.enum(["editor", "viewer", "none"]).openapi("OrgAccessLevel", {
  description:
    "What everyone in the organization can do with the object. `editor` is the default for an object nobody has shared.",
});
const EffectiveLevel = z.enum(["owner", "editor", "viewer", "none"]);

const ObjectAccessGrant = strict({
  principalKind: z.enum(["member", "role"]),
  principalId: z.string(),
  principalLabel: z.string().nullable(),
  level: AccessLevel,
  implicit: z
    .boolean()
    .describe("The report creator's ownership, implied rather than stored. Never send it back."),
}).openapi("ObjectAccessGrant");

const ObjectSharing = strict({
  objectType: ShareableObjectType,
  objectId: z.string(),
  orgAccess: OrgAccess,
  grants: z.array(ObjectAccessGrant),
  callerLevel: EffectiveLevel.describe("What the caller can do with this object."),
  inheritedFrom: strict({
    folderId: z.string(),
    folderName: z.string(),
    level: EffectiveLevel,
  })
    .nullable()
    .describe("Access the containing folder's explicit sharing already gives the caller."),
}).openapi("ObjectSharing");

const ObjectSharingInput = strict({
  orgAccess: OrgAccess,
  grants: z
    .array(
      strict({
        principalKind: z.enum(["member", "role"]),
        principalId: z.string().min(1),
        level: AccessLevel,
      }),
    )
    .max(100),
}).openapi("ObjectSharingInput");

export function registerCostVisibilityPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-visibility",
    tags: ["Team"],
    summary: "List cost visibility scopes",
    description:
      "Every scope narrowing which cost rows a role, member or API key can see. Scopes that apply to one caller are intersected.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Scopes",
        content: {
          "application/json": { schema: strict({ scopes: z.array(CostVisibilityScope) }) },
        },
      },
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-visibility",
    tags: ["Team"],
    summary: "Create or replace a cost visibility scope",
    description:
      "Upserts the scope of one principal. Roles and members need `team:role:write`; an API key's owner may also scope their own key with `apikeys:write`. Owners cannot be scoped, and cost-scoped callers cannot change scopes.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostVisibilityScopeInput } } },
    },
    responses: {
      200: {
        description: "The stored scope",
        content: { "application/json": { schema: CostVisibilityScope } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-visibility/{principalKind}/{principalId}",
    tags: ["Team"],
    summary: "Remove a cost visibility scope",
    request: {
      params: OrgIdParam.extend({
        principalKind: PrincipalKind.openapi({ param: { name: "principalKind", in: "path" } }),
        principalId: z.string().openapi({ param: { name: "principalId", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Removed", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  const sharingParams = OrgIdParam.extend({
    objectType: ShareableObjectType.openapi({ param: { name: "objectType", in: "path" } }),
    objectId: z.string().openapi({ param: { name: "objectId", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/sharing/{objectType}/{objectId}",
    tags: ["Costs"],
    summary: "Get an object's sharing",
    description:
      "Who can open or edit a cost report, report folder or dashboard. Needs viewer on the object and the family's read permission (`costs:read` / `dashboards:read`).",
    request: { params: sharingParams },
    responses: {
      200: { description: "Sharing", content: { "application/json": { schema: ObjectSharing } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/sharing/{objectType}/{objectId}",
    tags: ["Costs"],
    summary: "Replace an object's sharing",
    description:
      "Replaces the org-wide default and every grant. Owner on the object plus the family's write permission. At least one owner must remain.",
    request: {
      params: sharingParams,
      body: { content: { "application/json": { schema: ObjectSharingInput } } },
    },
    responses: {
      200: { description: "Sharing", content: { "application/json": { schema: ObjectSharing } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/sharing/{objectType}/{objectId}",
    tags: ["Costs"],
    summary: "Reset an object's sharing to the default",
    description:
      "Removes every grant and the org-wide setting, so everyone in the organization can edit again. Owner only. A report's creator remains its owner.",
    request: { params: sharingParams },
    responses: {
      200: { description: "Reset", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });
}

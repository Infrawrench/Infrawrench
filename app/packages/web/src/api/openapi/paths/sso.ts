import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const TAG = "Single sign-on";

const SsoDomain = strict({
  id: z.string().openapi({ example: "org_domain_01HXYZ" }),
  domain: z.string().openapi({ example: "acme.com" }),
  state: z.string().openapi({
    description: "`verified`, `pending` or `failed`. Only verified domains are enforced.",
    example: "verified",
  }),
  verificationStrategy: z.string().openapi({ example: "dns" }),
  verificationPrefix: z.string().nullable().openapi({
    description: "Name of the DNS TXT record to create while verification is pending.",
  }),
  verificationToken: z.string().nullable().openapi({
    description: "Value of the DNS TXT record to create while verification is pending.",
  }),
}).openapi("SsoDomain");

const SsoConnection = strict({
  id: z.string(),
  name: z.string(),
  type: z.string().openapi({ example: "OktaSAML" }),
  state: z.string().openapi({ description: "`active` once the IdP setup is complete." }),
}).openapi("SsoConnection");

const SsoDirectory = strict({
  id: z.string(),
  name: z.string(),
  type: z.string().openapi({ example: "okta scim v2.0" }),
  state: z.string(),
}).openapi("SsoDirectory");

const SsoSettings = strict({
  enforceSso: z.boolean().openapi({
    description:
      "Members whose email is in a verified domain must sign in through the org's SSO connection.",
  }),
  breakGlassUserIds: z.array(z.string()).openapi({
    description: "Owners who may sign in without SSO while it is enforced.",
  }),
  provisioningEnabled: z.boolean().openapi({
    description: "Directory Sync creates and removes memberships.",
  }),
  defaultRoleId: z.string().nullable().openapi({
    description:
      "Role for provisioned members none of whose groups is mapped. Null means the system member role.",
  }),
  autoAddSeats: z.boolean().openapi({
    description: "Buy a seat when provisioning needs one, instead of holding the member back.",
  }),
  updatedAt: IsoDateTime,
}).openapi("SsoSettings");

const SsoSettingsInput = strict({
  enforceSso: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Turning this on is refused unless a domain is verified, a connection is active, at least " +
        "one break-glass owner is set, and the caller's own session would still be allowed.",
    }),
  breakGlassUserIds: z.array(z.string()).max(5).optional().openapi({
    description: "Each id must belong to a current owner. At most 5.",
  }),
  provisioningEnabled: z.boolean().optional(),
  defaultRoleId: z.string().nullable().optional().openapi({
    description: "Never the owner role, and never a role granting permissions the caller lacks.",
  }),
  autoAddSeats: z.boolean().optional().openapi({
    description: "Turning this on also needs `billing:write`.",
  }),
}).openapi("SsoSettingsInput");

const SsoSessionState = z
  .enum(["sso", "not_sso", "outside_domains", "break_glass_owner", "unknown"])
  .openapi("SsoSessionState");

const SsoStatus = strict({
  planIncluded: z.boolean(),
  configured: z.boolean(),
  settings: SsoSettings.nullable(),
  domains: z.array(SsoDomain),
  connections: z.array(SsoConnection),
  directories: z.array(SsoDirectory),
  workosError: z.string().nullable(),
  owners: z.array(
    strict({ userId: z.string(), email: z.string(), displayName: z.string().nullable() }),
  ),
  currentSession: SsoSessionState,
  directoryMemberCounts: z.record(z.number().int()),
}).openapi("SsoStatus");

const SsoDirectoryMemberStatus = z
  .enum([
    "active",
    "observed",
    "deprovisioned",
    "seat_limit",
    "plan_required",
    "domain_unverified",
    "protected",
  ])
  .openapi("SsoDirectoryMemberStatus");

const SsoDirectoryMember = strict({
  id: z.string(),
  directoryId: z.string(),
  directoryUserId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  userId: z.string().nullable(),
  groupIds: z.array(z.string()),
  status: SsoDirectoryMemberStatus,
  provisionedByDirectory: z.boolean(),
  lastSyncedAt: IsoDateTime,
  deprovisionedAt: IsoDateTime.nullable(),
}).openapi("SsoDirectoryMember");

const SsoDirectoryGroup = strict({
  id: z.string().openapi({ example: "directory_group_01HXYZ" }),
  name: z.string().openapi({ example: "Platform engineers" }),
  directoryId: z.string(),
  directoryName: z.string(),
}).openapi("SsoDirectoryGroup");

const SsoGroupRoleMapping = strict({
  id: z.string(),
  directoryGroupId: z.string(),
  groupName: z.string(),
  roleId: z.string(),
  roleName: z.string().nullable(),
  position: z.number().int().openapi({
    description: "Evaluation order, lowest first. The first mapping whose group matches wins.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("SsoGroupRoleMapping");

const SsoGroupRoleMappingInput = strict({
  directoryGroupId: z.string().min(1).max(128),
  roleId: z.string().min(1).max(128).openapi({
    description: "Never the owner role, and never a role granting permissions the caller lacks.",
  }),
  position: z.number().int().min(0).max(10000).optional(),
}).openapi("SsoGroupRoleMappingInput");

const SsoGroupRoleMappingUpdate = strict({
  roleId: z.string().min(1).max(128).optional(),
  position: z.number().int().min(0).max(10000).optional(),
}).openapi("SsoGroupRoleMappingUpdate");

const SsoMappingPreviewInput = strict({
  mappings: z
    .array(
      strict({
        directoryGroupId: z.string(),
        groupName: z.string().optional(),
        roleId: z.string(),
        position: z.number().int().min(0).max(10000),
      }),
    )
    .max(500)
    .optional()
    .openapi({ description: "Unsaved mappings to preview. Omit to preview the saved ones." }),
  defaultRoleId: z.string().nullable().optional(),
}).openapi("SsoMappingPreviewInput");

const SsoMappingPreviewRow = strict({
  userId: z.string().nullable(),
  email: z.string(),
  status: SsoDirectoryMemberStatus,
  currentRoleId: z.string().nullable(),
  currentRoleName: z.string().nullable(),
  resolvedRoleId: z.string().nullable(),
  resolvedRoleName: z.string().nullable(),
  source: z.enum(["mapping", "default", "owner_unchanged"]),
  matchedGroupNames: z.array(z.string()),
  conflict: z.boolean().openapi({
    description: "More than one mapping matched with different roles; the first one won.",
  }),
  changes: z.boolean(),
}).openapi("SsoMappingPreviewRow");

const SsoSyncResult = strict({
  usersSeen: z.number().int(),
  provisioned: z.number().int(),
  deprovisioned: z.number().int(),
  rolesChanged: z.number().int(),
  skipped: z.number().int(),
}).openapi("SsoSyncResult");

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function registerSsoPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const base = "/api/org/{orgId}/sso";
  const idParam = OrgIdParam.extend({
    id: z.string().openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: base,
    tags: [TAG],
    summary: "Single sign-on status",
    description:
      "Settings, domains, connections and directories (read live from WorkOS), owners for the " +
      "break-glass picker, and how the caller's own session would fare under enforcement.",
    request: { params: OrgIdParam },
    responses: { 200: json(SsoStatus, "Status") },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/setup`,
    tags: [TAG],
    summary: "Start single sign-on setup",
    description: "Creates the WorkOS organization SSO hangs off. Idempotent.",
    request: { params: OrgIdParam },
    responses: {
      200: json(strict({ ok: z.literal(true), created: z.boolean() }), "Set up"),
      402: ErrorResponses[402],
      502: json(strict({ error: z.string() }), "WorkOS unavailable"),
    },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/portal-link`,
    tags: [TAG],
    summary: "Open the WorkOS Admin Portal",
    description:
      "A five-minute link for the customer's IT admin to configure the identity provider (`sso`), " +
      "the SCIM directory (`dsync`), or domain verification (`domain_verification`).",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: strict({ intent: z.enum(["sso", "dsync", "domain_verification"]) }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(strict({ link: z.string() }), "Portal link"),
      402: ErrorResponses[402],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/domains`,
    tags: [TAG],
    summary: "Add a domain",
    description: "Returns the DNS TXT record to create; verify it with the verify route.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ domain: z.string().min(3).max(253) }) } },
        required: true,
      },
    },
    responses: { 200: json(SsoDomain, "Domain"), 400: ErrorResponses[400] },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/domains/{id}/verify`,
    tags: [TAG],
    summary: "Check a domain's DNS verification record",
    request: { params: idParam },
    responses: { 200: json(SsoDomain, "Domain"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "delete",
    path: `${base}/domains/{id}`,
    tags: [TAG],
    summary: "Remove a domain",
    request: { params: idParam },
    responses: { 200: json(Ok, "Removed"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "put",
    path: `${base}/settings`,
    tags: [TAG],
    summary: "Update single sign-on settings",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SsoSettingsInput } }, required: true },
    },
    responses: {
      200: json(SsoSettings, "Saved"),
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/groups`,
    tags: [TAG],
    summary: "List directory groups",
    description: "Every group across the org's directories, for the mapping picker.",
    request: { params: OrgIdParam },
    responses: { 200: json(strict({ groups: z.array(SsoDirectoryGroup) }), "Groups") },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/directory-members`,
    tags: [TAG],
    summary: "List directory members",
    description: "Every directory user seen, and whether they became a member.",
    request: { params: OrgIdParam },
    responses: { 200: json(strict({ members: z.array(SsoDirectoryMember) }), "Members") },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/sync`,
    tags: [TAG],
    summary: "Sync the directory now",
    description:
      "Reconciles every directory user: provisions, deprovisions and re-applies group mappings. " +
      "Repairs any webhook that was missed.",
    request: { params: OrgIdParam },
    responses: { 200: json(SsoSyncResult, "Result"), 402: ErrorResponses[402] },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/group-mappings`,
    tags: [TAG],
    summary: "List group to role mappings",
    request: { params: OrgIdParam },
    responses: { 200: json(strict({ mappings: z.array(SsoGroupRoleMapping) }), "Mappings") },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/group-mappings/{id}`,
    tags: [TAG],
    summary: "Get a group to role mapping",
    request: { params: idParam },
    responses: { 200: json(SsoGroupRoleMapping, "Mapping"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/group-mappings`,
    tags: [TAG],
    summary: "Map a directory group to a role",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: SsoGroupRoleMappingInput } },
        required: true,
      },
    },
    responses: {
      201: json(SsoGroupRoleMapping, "Created"),
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: `${base}/group-mappings/{id}`,
    tags: [TAG],
    summary: "Change a mapping's role or position",
    request: {
      params: idParam,
      body: {
        content: { "application/json": { schema: SsoGroupRoleMappingUpdate } },
        required: true,
      },
    },
    responses: {
      200: json(SsoGroupRoleMapping, "Updated"),
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: `${base}/group-mappings/{id}`,
    tags: [TAG],
    summary: "Remove a group to role mapping",
    request: { params: idParam },
    responses: { 200: json(Ok, "Removed"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/group-mappings/preview`,
    tags: [TAG],
    summary: "Preview group to role mappings",
    description: "What the mappings would do to every directory member. Changes nothing.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SsoMappingPreviewInput } } },
    },
    responses: { 200: json(strict({ rows: z.array(SsoMappingPreviewRow) }), "Preview") },
  });
}

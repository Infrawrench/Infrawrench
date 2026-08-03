import { z } from "../zod";
import {
  strict,
  ErrorResponses,
  Uuid,
  IsoDateTime,
  Ok,
  OrgIdParam,
  JsonObject,
  ResourceId,
} from "../common";
import type { BuildContext } from "../context";

const CredentialFieldRegion = strict({
  id: z.string(),
  label: z.string(),
  location: z.string().optional(),
  flag: z.string().optional(),
}).openapi("CredentialFieldRegion");

const CredentialField = strict({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  sensitive: z.boolean().optional(),
  multiline: z.boolean().optional(),
  defaultValue: z.string().optional(),
  regions: z.array(CredentialFieldRegion).optional(),
  helpLink: strict({ label: z.string(), url: z.string() }).optional(),
}).openapi("CredentialField");

const PreflightPermission = strict({
  id: z.string().openapi({
    description: "Provider-native permission string, e.g. `ce:GetCostAndUsage`.",
  }),
  label: z.string(),
}).openapi("PreflightPermission");

const PreflightCapability = strict({
  id: z.string().openapi({ example: "costs" }),
  label: z.string(),
  description: z.string().optional(),
  requiredPermissions: z.array(PreflightPermission),
  essential: z.boolean().optional(),
}).openapi("PreflightCapability");

const PreflightDeclaration = strict({
  capabilities: z.array(PreflightCapability),
  templateFormat: strict({
    label: z.string(),
    language: z.enum(["json", "yaml", "text"]),
  }).optional(),
}).openapi("PreflightDeclaration");

const PluginSummary = strict({
  id: z.string(),
  displayName: z.string(),
  logoSvg: z.string(),
  credentialFields: z.array(CredentialField),
  preflight: PreflightDeclaration.nullable().openapi({
    description:
      "Declared when the plugin supports credential preflight (per-capability permission checks). `null` for plugins without it.",
  }),
}).openapi("PluginSummary");

const PreflightCheck = strict({
  capabilityId: z.string(),
  status: z.enum(["ok", "missing", "unknown"]),
  missingPermissions: z.array(PreflightPermission),
  message: z.string().nullable(),
  helpLink: strict({ label: z.string(), url: z.string() }).nullable(),
}).openapi("PreflightCheck");

const PreflightReport = strict({
  pluginId: z.string(),
  supported: z.boolean(),
  identity: z.string().nullable().openapi({
    description: "Provider-side identity the credential resolved to (ARN, service account…).",
  }),
  checks: z.array(PreflightCheck),
}).openapi("PreflightReport");

const AdHocPreflightRequest = strict({
  pluginId: z.string(),
  credentials: z.record(z.string()),
  bastionId: Uuid.optional().nullable().openapi({
    description: "Probe through this bastion, matching how the account will egress once created.",
  }),
}).openapi("PreflightRequest");

const PolicyTemplateResponse = strict({
  template: strict({
    formatLabel: z.string(),
    language: z.enum(["json", "yaml", "text"]),
    document: z.string(),
    instructions: z.string().optional(),
    helpLink: strict({ label: z.string(), url: z.string() }).optional(),
  }).openapi("PolicyTemplate"),
}).openapi("PolicyTemplateResponse");

const Account = strict({
  id: Uuid,
  pluginId: z.string(),
  displayName: z.string(),
  bastionId: Uuid.nullable().openapi({
    description:
      "Bastion this account's cloud-API egress is routed through. `null` ⇒ direct egress.",
  }),
  createdAt: IsoDateTime,
}).openapi("Account");

const CreateAccountRequest = strict({
  pluginId: z.string(),
  displayName: z.string().min(1),
  credentials: z.record(z.string()),
  bastionId: Uuid.optional().nullable().openapi({
    description: "Optional bastion id to route this account's cloud API traffic through.",
  }),
}).openapi("CreateAccountRequest");

const CreateAccountResponse = strict({
  id: Uuid,
  syncError: strict({ message: z.string() }).optional(),
}).openapi("CreateAccountResponse");

const UpdateAccountRequest = strict({
  displayName: z.string().min(1).optional(),
  bastionId: Uuid.nullable().optional().openapi({
    description:
      "Pass `null` to unbind, a uuid to bind, or omit the field to leave the binding unchanged.",
  }),
}).openapi("UpdateAccountRequest");

const UpdateAccountResponse = strict({
  id: Uuid,
  displayName: z.string(),
  bastionId: Uuid.nullable(),
}).openapi("UpdatedAccount");

const Resource = strict({
  id: ResourceId,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  displayName: z.string(),
  externalId: z.string().nullable(),
  fieldsJson: JsonObject,
  outputsJson: JsonObject,
  parentResourceId: ResourceId.nullable(),
}).openapi("Resource");

/**
 * What `sync-type` hands back: the same rows as `Resource`, minus `accountId`
 * — the caller named the account in the path, so the route doesn't echo it.
 */
const SyncedResource = Resource.omit({ accountId: true }).openapi("SyncedResource");

const SyncResponse = strict({ synced: z.number().int().nonnegative() }).openapi("SyncResponse");

const ResourceTypeSummary = strict({
  id: z.string(),
  displayName: z.string(),
  pluralDisplayName: z.string().optional(),
  parentTypeId: z.string().optional(),
  supportsCreate: z.boolean(),
  attachTargets: z
    .array(
      strict({
        pluginId: z.string(),
        resourceTypeId: z.string(),
        matchField: z.string().optional(),
        verb: z.string().optional(),
      }),
    )
    .optional(),
  isSshHost: z.boolean().optional(),
  sshTunnelAttachSource: z.boolean().optional(),
  schedulable: z
    .boolean()
    .optional()
    .describe(
      "The type declares lifecycle start/stop actions, so its resources can carry a sleep/wake schedule.",
    ),
}).openapi("ResourceTypeSummary");

const AccountDetail = strict({
  account: strict({
    id: Uuid,
    pluginId: z.string(),
    displayName: z.string(),
  }),
  resourceTypes: z.array(ResourceTypeSummary),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string(),
}).openapi("AccountDetail");

export function registerAccountPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts/plugins",
    tags: ["Accounts"],
    summary: "List installed plugins and their credential fields",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Plugins",
        content: { "application/json": { schema: z.array(PluginSummary) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts/plugins/{pluginId}/policy-template",
    tags: ["Accounts"],
    summary: "Generate a least-privilege credential template for a plugin",
    description:
      "Returns the paste-ready credential document (IAM policy JSON, custom role YAML, token template…) scoped to the requested capability ids. Omitting `capabilities` selects every declared capability. 400 for plugins that don't provide a template.",
    request: {
      params: OrgIdParam.extend({
        pluginId: enums.PluginId.openapi({ param: { name: "pluginId", in: "path" } }),
      }),
      query: strict({
        capabilities: z.string().optional().openapi({
          description: "Comma-separated capability ids, e.g. `resources,costs`.",
          example: "resources,costs",
        }),
      }),
    },
    responses: {
      200: {
        description: "Template",
        content: { "application/json": { schema: PolicyTemplateResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/accounts/preflight",
    tags: ["Accounts"],
    summary: "Probe credentials before creating an account",
    description:
      "Runs the plugin's per-capability permission checks against the submitted credentials. Nothing is stored — use it from the add-account flow before committing.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: AdHocPreflightRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Preflight report",
        content: { "application/json": { schema: PreflightReport } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/accounts/{id}/preflight",
    tags: ["Accounts"],
    summary: "Re-run credential preflight on a stored account",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Preflight report",
        content: { "application/json": { schema: PreflightReport } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts",
    tags: ["Accounts"],
    summary: "List accounts in this organization",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Accounts",
        content: { "application/json": { schema: z.array(Account) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/accounts",
    tags: ["Accounts"],
    summary: "Create an account",
    description:
      "Stores encrypted credentials and triggers a first sync. `syncError` is set if the initial sync failed (the account row is still created).",
    request: {
      params: OrgIdParam,
      body: {
        content: {
          "application/json": {
            schema: CreateAccountRequest.extend({ pluginId: enums.PluginId }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateAccountResponse } },
      },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/accounts/{id}",
    tags: ["Accounts"],
    summary: "Delete an account",
    request: {
      params: OrgIdParam.extend({
        id: Uuid.openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/accounts/{id}",
    tags: ["Accounts"],
    summary: "Update an account (rename and/or change bastion binding)",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: UpdateAccountRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: UpdateAccountResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts/{id}/credentials",
    tags: ["Accounts"],
    summary: "Fetch the decrypted credentials for an account",
    description:
      "Returns the credentials map as it was originally submitted. Sensitive — gate access carefully.",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Credentials",
        content: { "application/json": { schema: z.record(z.string()) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/accounts/{id}/credentials",
    tags: ["Accounts"],
    summary: "Rotate the credentials an account uses to talk to the upstream provider",
    description:
      "Replaces the encrypted credentials blob in place. Used to swap a stale or " +
      "narrowly-scoped token for a freshly-minted one without recreating the account " +
      "(preserves existing resources, pins, dashboards, sync history).",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: {
        content: {
          "application/json": {
            schema: strict({
              credentials: z.record(z.string()).openapi({
                description:
                  "Complete credentials map. Sensitive fields the caller doesn't want " +
                  "to change should be re-sent with their previous value (the server " +
                  "doesn't merge with the existing blob).",
              }),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: strict({ ok: z.literal(true) }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts/{id}/resources",
    tags: ["Accounts"],
    summary: "List cached resources for an account",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      query: strict({
        topLevelOnly: z.enum(["true", "false"]).optional().openapi({
          description: "If `true`, only resources with no `parentResourceId` are returned.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Resources",
        content: { "application/json": { schema: z.array(Resource) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/accounts/{id}/sync",
    tags: ["Accounts"],
    summary: "Sync all resource types for an account",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Sync result",
        content: { "application/json": { schema: SyncResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/accounts/{id}/detail",
    tags: ["Accounts"],
    summary: "Account metadata + resource type list",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "Detail", content: { "application/json": { schema: AccountDetail } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/accounts/{id}/sync-type/{typeId}",
    tags: ["Accounts"],
    summary: "Sync a single resource type and return its resources",
    request: {
      params: OrgIdParam.extend({
        id: Uuid.openapi({ param: { name: "id", in: "path" } }),
        typeId: enums.ResourceTypeId.openapi({ param: { name: "typeId", in: "path" } }),
      }),
    },
    responses: {
      200: {
        description: "Resources",
        content: { "application/json": { schema: z.array(SyncedResource) } },
      },
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });
}

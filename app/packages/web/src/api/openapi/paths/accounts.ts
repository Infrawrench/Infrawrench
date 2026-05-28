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

const PluginSummary = strict({
  id: z.string(),
  displayName: z.string(),
  logoSvg: z.string(),
  credentialFields: z.array(CredentialField),
}).openapi("PluginSummary");

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
        content: { "application/json": { schema: z.array(Resource) } },
      },
      404: ErrorResponses[404],
      500: ErrorResponses[500],
    },
  });
}

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
import type { BuildContext } from "../index";

const CredentialField = strict({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  sensitive: z.boolean().optional(),
  multiline: z.boolean().optional(),
  defaultValue: z.string().optional(),
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
  createdAt: IsoDateTime,
}).openapi("Account");

const CreateAccountRequest = strict({
  pluginId: z.string(),
  displayName: z.string().min(1),
  credentials: z.record(z.string()),
}).openapi("CreateAccountRequest");

const CreateAccountResponse = strict({
  id: Uuid,
  syncError: strict({ message: z.string() }).optional(),
}).openapi("CreateAccountResponse");

const RenameAccountRequest = strict({ displayName: z.string().min(1) }).openapi(
  "RenameAccountRequest",
);

const RenameAccountResponse = strict({
  id: Uuid,
  displayName: z.string(),
}).openapi("RenamedAccount");

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
    summary: "Rename an account",
    request: {
      params: OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) }),
      body: { content: { "application/json": { schema: RenameAccountRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Renamed",
        content: { "application/json": { schema: RenameAccountResponse } },
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

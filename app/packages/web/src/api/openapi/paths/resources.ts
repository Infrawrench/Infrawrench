import { z } from "../zod";
import {
  strict,
  ErrorResponses,
  Uuid,
  Ok,
  OrgIdParam,
  JsonObject,
  ResourceId,
  ResourceStatus,
} from "../common";
import type { BuildContext } from "../context";

const StatusDot = strict({
  kind: z.literal("status-dot"),
  status: ResourceStatus,
  label: z.string().optional(),
}).openapi("StatusDot");

const ChildTypeRef = strict({
  id: z.string(),
  displayName: z.string(),
  pluralDisplayName: z.string().optional(),
  supportsCreate: z.boolean(),
}).openapi("ChildTypeRef");

const ChildResourceRef = strict({
  id: ResourceId,
  displayName: z.string(),
  resourceTypeId: z.string(),
  pluginId: z.string(),
  accountId: Uuid,
  status: StatusDot.optional(),
}).openapi("ChildResourceRef");

const PeerPaneStub = strict({
  tabLabel: z.string(),
  pluginLogoSvg: z.string(),
  peerPluginId: z.string(),
}).openapi("PeerPaneStub");

const PeerPane = PeerPaneStub.extend({ schema: JsonObject }).openapi("PeerPane");

const CredentialFormat = strict({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  fileExtension: z.string().optional(),
  mimeType: z.string().optional(),
}).openapi("CredentialFormat");

const EditableField = strict({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["string", "number", "boolean", "enum", "secret", "association"]),
  required: z.boolean(),
  description: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
}).openapi("EditableField");

const ResourceDetailResponse = strict({
  detailSchema: JsonObject.openapi({
    description: "Plugin-rendered DetailViewSchema. Free-form by design.",
  }),
  childResources: z.array(ChildResourceRef),
  childTypes: z.array(ChildTypeRef),
  pluginId: z.string(),
  pluginLogoSvg: z.string(),
  resourceId: ResourceId,
  accountId: Uuid,
  resourceTypeId: z.string(),
  peerPanes: z.array(PeerPane),
  peerIntegrationStubs: z.array(PeerPaneStub),
  canDelete: z.boolean(),
  canEdit: z.boolean(),
  editableFields: z.array(EditableField),
  credentialFormats: z.array(CredentialFormat),
  hasManifestEditor: z.boolean(),
  hasSecretVersions: z.boolean(),
  resourceDisplayName: z.string(),
  resourceTypeLabel: z.string(),
  resourceFields: JsonObject,
  hasSqlEditor: z.boolean(),
  hasStorageBrowser: z.boolean(),
  hasArtifactRegistry: z.boolean(),
  hasKvConsole: z.boolean(),
  kvDriverName: z.string().optional(),
  isMongoDb: z.boolean(),
  hasDockerActions: z.boolean(),
  hasSshTerminal: z.boolean(),
  hasSftpBrowser: z.boolean(),
  sshHost: z.string().nullable(),
  sshPrivateHost: z.string().nullable().optional(),
  defaultSshUsername: z.string().nullable(),
  containerId: z.string(),
  databaseName: z.string(),
  storageBucketName: z.string(),
  supportsMetrics: z.boolean(),
}).openapi("ResourceDetail");

const ManifestResponse = strict({ manifest: z.string() }).openapi("Manifest");

const ApplyManifestRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  manifest: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("ApplyManifestRequest");

const ImportYamlRequest = strict({
  accountId: Uuid,
  yaml: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("ImportYamlRequest");

const DescribeRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: ResourceId.optional(),
}).openapi("DescribeRequest");

const DescribeResponse = strict({ text: z.string() }).openapi("DescribeResponse");

const LogsRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: ResourceId.optional(),
  tailLines: z.number().int().positive().optional(),
  container: z.string().optional(),
  previous: z.boolean().optional(),
}).openapi("LogsRequest");

const LogsResponse = strict({
  lines: z.array(z.string()),
  nextPageToken: z.string().optional(),
  truncated: z.boolean().optional(),
}).openapi("LogsResponse");

const SecretVersion = strict({
  id: z.string(),
  state: z.enum(["ENABLED", "DISABLED", "DESTROYED"]),
  createdAt: z.string(),
}).openapi("SecretVersion");

const SecretVersionsResponse = strict({ versions: z.array(SecretVersion) }).openapi(
  "SecretVersionsResponse",
);

const SecretAccessRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  versionId: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("SecretAccessRequest");

const SecretAccessResponse = strict({ value: z.string() }).openapi("SecretAccessResponse");

const SecretAddRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  value: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("SecretAddRequest");

const SecretModifyRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  versionId: z.string(),
  action: z.enum(["enable", "disable", "destroy"]),
  parentResourceId: ResourceId.optional(),
}).openapi("SecretModifyRequest");

const SecretVersionResponse = strict({ version: SecretVersion }).openapi("SecretVersionResponse");

const InvokeActionRequest = strict({
  pluginId: z.string(),
  accountId: Uuid,
  resourceTypeId: z.string(),
  resourceId: ResourceId,
  actionId: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("InvokeActionRequest");

const NoSqlCommandRequest = strict({
  pluginId: z.string(),
  accountId: Uuid,
  resourceTypeId: z.string(),
  resourceId: ResourceId,
  command: z.string(),
  args: z.array(z.union([z.string(), z.number()])),
  parentResourceId: ResourceId.optional(),
}).openapi("NoSqlCommandRequest");

const AttachRequest = strict({
  pluginId: z.string(),
  accountId: Uuid,
  sourceTypeId: z.string(),
  sourceResourceId: ResourceId,
  targetTypeId: z.string(),
  targetResourceId: ResourceId,
}).openapi("AttachRequest");

const ExportCredentialRequest = strict({
  resourceId: ResourceId,
  accountId: Uuid,
  formatId: z.string(),
  parentResourceId: ResourceId.optional(),
}).openapi("ExportCredentialRequest");

const CredentialExport = strict({
  content: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  fields: z.record(z.string()).optional(),
  warning: z.string().optional(),
}).openapi("CredentialExport");

const CreateRequest = strict({
  accountId: Uuid,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  fields: z.record(z.string()),
  parentResourceId: ResourceId.optional(),
}).openapi("CreateResourceRequest");

const CreateResponse = strict({
  id: ResourceId,
  displayName: z.string(),
  warnings: z.array(z.string()).optional(),
}).openapi("CreateResourceResponse");

const UpdateRequest = strict({
  accountId: Uuid,
  pluginId: z.string(),
  resourceTypeId: z.string(),
  resourceId: ResourceId,
  fields: z.record(z.string()),
  parentResourceId: ResourceId.optional(),
}).openapi("UpdateResourceRequest");

const UpdateResponse = strict({
  id: ResourceId,
  displayName: z.string(),
  fields: z.record(z.string()),
}).openapi("UpdateResourceResponse");

const CreateConfigRequest = strict({
  accountId: Uuid,
  resourceTypeId: z.string(),
  pluginId: z.string().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("CreateConfigRequest");

const PickerResourcesRequest = strict({
  sources: z.array(
    strict({ pluginId: z.string(), resourceTypeId: z.string(), outputKey: z.string() }),
  ),
  accountId: Uuid,
  /**
   * Optional regional scope. When set, plugins that fan out across regions
   * (e.g. AWS) restrict the listing to this region. Used by create forms to
   * avoid loading resources from every region for a region-locked field.
   */
  regionHint: z.string().optional(),
}).openapi("PickerResourcesRequest");

const PickerResource = strict({
  id: ResourceId,
  label: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  accountId: Uuid,
  outputKey: z.string(),
  outputValue: z.string(),
}).openapi("PickerResource");

const CreatePricingRequest = strict({
  accountId: Uuid,
  resourceTypeId: z.string(),
  regionId: z.string().optional(),
  sizes: z.array(strict({ id: z.string(), vcpus: z.number(), memoryMb: z.number() })),
  pluginId: z.string().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("CreatePricingRequest");

const CreateCostEstimateRequest = strict({
  accountId: Uuid,
  resourceTypeId: z.string(),
  fields: z.record(z.string()),
  pluginId: z.string().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("CreateCostEstimateRequest");

const FieldActionRequest = strict({
  accountId: Uuid,
  resourceTypeId: z.string(),
  fieldKey: z.string(),
  actionId: z.string(),
  fields: z.record(z.string()),
  /**
   * Values from the action's inline mini-form (declared via
   * `FieldAction.formFields`). Kept separate from `fields` so the action's
   * own field keys can't collide with outer create-form keys.
   */
  actionFields: z.record(z.string()).optional(),
  pluginId: z.string().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("FieldActionRequest");

const FieldActionResponse = strict({
  value: z.string(),
  option: strict({ id: z.string(), label: z.string() }).optional(),
}).openapi("FieldActionResponse");

const PeerPanesRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: ResourceId.optional(),
}).openapi("PeerPanesRequest");

const MetricsRequest = strict({
  accountId: Uuid,
  resourceId: ResourceId,
  startMs: z.number().int().optional(),
  endMs: z.number().int().optional(),
  parentResourceId: ResourceId.optional(),
}).openapi("MetricsRequest");

const MetricSeries = strict({
  label: z.string(),
  unit: z.string().optional(),
  points: z.array(strict({ ts: z.number(), value: z.number() })),
}).openapi("MetricSeries");

const MetricsResponse = strict({ series: z.array(MetricSeries) }).openapi("MetricsResponse");

export function registerResourcePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const pluginTypeParams = OrgIdParam.extend({
    pluginId: enums.PluginId.openapi({ param: { name: "pluginId", in: "path" } }),
    typeId: enums.ResourceTypeId.openapi({ param: { name: "typeId", in: "path" } }),
  });
  const pluginParams = OrgIdParam.extend({
    pluginId: enums.PluginId.openapi({ param: { name: "pluginId", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/detail",
    tags: ["Resources"],
    summary: "Full resource detail page payload",
    description:
      "Performs a live `listResources` against the provider, falls back to DB on failure, and returns the plugin's `renderDetail` schema plus host-derived flags (SQL/KV/SSH availability, child resources, peer panes, etc).",
    request: {
      params: pluginTypeParams,
      query: strict({
        resourceId: ResourceId.openapi({ param: { name: "resourceId", in: "query" } }),
        accountId: Uuid.optional().openapi({ param: { name: "accountId", in: "query" } }),
        parentResourceId: ResourceId.optional().openapi({
          param: { name: "parentResourceId", in: "query" },
        }),
        includePeerPanes: z
          .enum(["true", "false"])
          .optional()
          .openapi({ description: "Default true. If false, peer panes are returned as stubs." }),
      }),
    },
    responses: {
      200: {
        description: "Detail",
        content: { "application/json": { schema: ResourceDetailResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/manifest",
    tags: ["Resources"],
    summary: "Fetch the raw manifest (YAML/JSON) for a resource",
    request: {
      params: pluginTypeParams,
      query: strict({
        resourceId: ResourceId.openapi({ param: { name: "resourceId", in: "query" } }),
        accountId: Uuid.openapi({ param: { name: "accountId", in: "query" } }),
        parentResourceId: ResourceId.optional().openapi({
          param: { name: "parentResourceId", in: "query" },
        }),
      }),
    },
    responses: {
      200: {
        description: "Manifest",
        content: { "application/json": { schema: ManifestResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/manifest",
    tags: ["Resources"],
    summary: "Apply an edited manifest to a resource",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: ApplyManifestRequest } }, required: true },
    },
    responses: {
      200: { description: "Applied", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/import-yaml",
    tags: ["Resources"],
    summary: "Bulk-import resources from YAML (kubectl apply -f equivalent)",
    request: {
      params: pluginParams,
      body: { content: { "application/json": { schema: ImportYamlRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Import result",
        content: { "application/json": { schema: JsonObject } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/describe",
    tags: ["Resources"],
    summary: "Get human-readable describe text for a resource",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: DescribeRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Describe text",
        content: { "application/json": { schema: DescribeResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/logs",
    tags: ["Resources"],
    summary: "Fetch logs for a resource",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: LogsRequest } }, required: true },
    },
    responses: {
      200: { description: "Logs", content: { "application/json": { schema: LogsResponse } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/secret-versions",
    tags: ["Resources"],
    summary: "List secret versions for a versioned-secret resource",
    request: {
      params: pluginTypeParams,
      query: strict({
        resourceId: ResourceId.openapi({ param: { name: "resourceId", in: "query" } }),
        accountId: Uuid.openapi({ param: { name: "accountId", in: "query" } }),
        parentResourceId: ResourceId.optional().openapi({
          param: { name: "parentResourceId", in: "query" },
        }),
      }),
    },
    responses: {
      200: {
        description: "Versions",
        content: { "application/json": { schema: SecretVersionsResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/secret-versions/access",
    tags: ["Resources"],
    summary: "Reveal the plaintext value of a specific version (one-time)",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: SecretAccessRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Plaintext",
        content: { "application/json": { schema: SecretAccessResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/secret-versions/add",
    tags: ["Resources"],
    summary: "Add a new secret version",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: SecretAddRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Added",
        content: { "application/json": { schema: SecretVersionResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/secret-versions/modify",
    tags: ["Resources"],
    summary: "Enable/disable/destroy a secret version",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: SecretModifyRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Modified",
        content: { "application/json": { schema: SecretVersionResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}",
    tags: ["Resources"],
    summary: "Delete a resource via the plugin",
    request: {
      params: pluginTypeParams,
      query: strict({
        resourceId: ResourceId.openapi({ param: { name: "resourceId", in: "query" } }),
        accountId: Uuid.openapi({ param: { name: "accountId", in: "query" } }),
        parentResourceId: ResourceId.optional().openapi({
          param: { name: "parentResourceId", in: "query" },
        }),
      }),
    },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/invoke-action",
    tags: ["Resources"],
    summary: "Invoke a plugin-defined action on a resource",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: InvokeActionRequest } }, required: true },
    },
    responses: {
      200: { description: "Invoked", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/nosql-command",
    tags: ["Resources"],
    summary: "Run a NoSQL document-browser command (e.g. MongoDB shell)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: NoSqlCommandRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Command result",
        content: { "application/json": { schema: strict({ result: JsonObject }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/attach",
    tags: ["Resources"],
    summary: "Attach a resource onto another (e.g. disk → VM)",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AttachRequest } }, required: true },
    },
    responses: {
      200: { description: "Attached", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/export-credential",
    tags: ["Resources"],
    summary: "Export a credential file for a resource (one-time reveal)",
    request: {
      params: pluginTypeParams,
      body: {
        content: { "application/json": { schema: ExportCredentialRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Credential file",
        content: { "application/json": { schema: CredentialExport } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/create",
    tags: ["Resources"],
    summary: "Create a new resource via its plugin",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateRequest } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CreateResponse } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/update",
    tags: ["Resources"],
    summary: "Update a resource via its plugin",
    description:
      "Applies the supplied field changes upstream and persists the refreshed fields/display name to the DB. The body's `fields` map only carries the keys the caller actually changed.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: UpdateRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: UpdateResponse } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/create-config",
    tags: ["Resources"],
    summary: "Get the dynamic create form for a resource type",
    description:
      "Calls the plugin's `getCreateConfig`. The returned `CreateResourceConfig` is plugin-shaped — see `JsonObject`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateConfigRequest } }, required: true },
    },
    responses: {
      200: { description: "Config", content: { "application/json": { schema: JsonObject } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/picker-resources",
    tags: ["Resources"],
    summary: "Fetch options for a `resource-picker` field",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PickerResourcesRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Options",
        content: { "application/json": { schema: z.array(PickerResource) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/create-pricing",
    tags: ["Resources"],
    summary: "Pricing per size for a create form",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreatePricingRequest } }, required: true },
    },
    responses: {
      200: {
        description:
          "Map of `sizeId → pricing`. Empty object when the plugin doesn't support pricing.",
        content: { "application/json": { schema: z.record(JsonObject) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/field-action",
    tags: ["Resources"],
    summary: "Execute an in-form field action (e.g. generate an IAM role)",
    description:
      "Calls the plugin's `executeFieldAction`. Returns `{ value }` to assign to the field; for `select` fields the optional `option` should be spliced into the options list so the new value can be displayed.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: FieldActionRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Action result",
        content: { "application/json": { schema: FieldActionResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/create-cost-estimate",
    tags: ["Resources"],
    summary: "Cost estimate for the current create form values",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: CreateCostEstimateRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Estimate",
        content: { "application/json": { schema: strict({ estimate: JsonObject.nullable() }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/peer-panes",
    tags: ["Resources"],
    summary: "Lazy-fetch peer-integration panes for a resource",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: PeerPanesRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Peer panes",
        content: { "application/json": { schema: z.array(PeerPane) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/resources/{pluginId}/{typeId}/metrics",
    tags: ["Resources"],
    summary: "Fetch metric series for a resource",
    request: {
      params: pluginTypeParams,
      body: { content: { "application/json": { schema: MetricsRequest } }, required: true },
    },
    responses: {
      200: { description: "Metrics", content: { "application/json": { schema: MetricsResponse } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}

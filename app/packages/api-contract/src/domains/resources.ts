/**
 * Resources: `/api/org/:orgId/resources`, the endpoint definitions.
 *
 * The per-resource surface every detail page, create form and action button
 * drives: the detail payload with its host-derived feature flags, manifests and
 * logs, secret versions, create / update / delete, the create form's lookups
 * (dynamic config, pickers, pricing, field actions, cost and carbon estimate),
 * plugin-defined actions, credential and Terraform export, peer panes,
 * metrics, and the SSH service installer. Each handler ends in a call to the
 * resource's plugin through the host.
 *
 * The request bodies are the documented contracts the clients (web, desktop,
 * mobile) were typed against. The streaming chat turn and the publish, speech
 * and tunnel endpoints were never in the published spec and stay out of it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength, RequiredTag } from "../schemas";
import {
  DocumentedPermission,
  InvalidRequestMessage,
  RequiredPermission,
  SuccessDescription,
} from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, InternalServerError, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { ChangeFreezeBlocked } from "../http/schemas/change-freeze";
import { JsonObject, Ok, OrgParams, ResourceId, Undocumented, Uuid } from "../http/schemas/common";
import { documentedAs, requiredQuery } from "../http/schemas/documented";
import { PluginId, ResourceTypeId } from "../http/schemas/plugin-registry";
import { SshHostKeyTrustRequired } from "../http/schemas/ssh-host-key-trust";
import { TerraformExport } from "../http/schemas/terraform-export";

/*
 * One resource's carbon, beside its price on `POST /resources/cost-estimate`.
 * The org-wide estimate (`GET /carbon`) is its own domain, which defines
 * `CarbonAssumptions` and the rows; `CarbonFootprint` and this component are
 * the route's own.
 */
const CarbonUnestimatedReason = Schema.Literals([
  "unsupported-provider",
  "unknown-region",
  "unknown-size",
]).annotate({
  description:
    "Why a resource has no estimate. Reported per resource rather than folded into the total: " +
    "a figure that quietly excluded a third of the estate would read as a complete answer.",
});

const CarbonFootprint = Schema.Struct({
  vcpus: Schema.Finite.annotate({ description: "vCPUs per unit." }),
  count: Schema.Int.annotate({
    description: "Units the figure covers (node count); 1 for one machine.",
  }),
  region: Schema.String,
  grid: Schema.String.annotate({
    description:
      "The coefficient table the region resolved in: `aws`, `gcp`, `azure`, `hetzner`...",
  }),
  gridIntensity: Schema.Finite.annotate({
    description: "Grams CO2e per kWh used for this row: the published figure, not a band.",
  }),
  gridZone: Schema.String.annotate({
    description: "What the grid figure describes, e.g. `Germany`.",
  }),
  gridBasis: Schema.Literals(["ccf", "ember-2024"]).annotate({
    description:
      "`ccf`: Cloud Carbon Footprint's per-region table. `ember-2024`: Ember's 2024 lifecycle " +
      "figure for the country.",
  }),
  pue: Schema.Finite.annotate({
    description: "Datacentre overhead used: regional where published, else fleet.",
  }),
  kwh: Schema.Finite,
  kgCo2e: Schema.Finite,
}).annotate({ identifier: "CarbonFootprint" });

const ResourceCarbonEstimate = Schema.Struct({
  estimate: Schema.NullOr(CarbonFootprint).annotate({
    description: "Monthly (730 h) footprint, or null.",
  }),
  // Null when there is an estimate, or when the type is out of scope.
  reason: Schema.NullOr(CarbonUnestimatedReason),
  inScope: Schema.Boolean.annotate({
    description: "False when the type declares nothing to read: a bucket, a DNS record.",
  }),
  role: Schema.Literals(["instance", "aggregate"]).annotate({
    description:
      "`aggregate`: a group (a managed cluster) whose machines are also listed in their own " +
      "right; shown per resource, never summed into the org total.",
  }),
  // The fields of `CarbonAssumptions` a single estimate carries, inline as before.
  assumptions: Schema.Struct({
    cpuUtilization: Schema.Finite.annotate({
      description:
        "Assumed average CPU utilisation, 0 to 1. **The largest single source of error**, stated " +
        "here rather than buried in a constant: the product does not collect per-resource CPU " +
        "history for every provider, and a figure derived from the few that do would be " +
        "quietly inconsistent across an estate.",
    }),
    coefficientSource: Schema.String,
    coefficientVintage: Schema.String,
    scope: Schema.String.annotate({
      description: "What the estimate covers, in one sentence a reader can check.",
    }),
  }),
}).annotate({ identifier: "ResourceCarbonEstimate" });

const ResourceStatus = Schema.Literals([
  "healthy",
  "degraded",
  "error",
  "unknown",
  "provisioning",
  "info",
]).annotate({
  identifier: "ResourceStatus",
  description: "Normalized status reported by a plugin's renderSidebarItem/renderDetail.",
});

const StatusDot = Schema.Struct({
  kind: Schema.Literal("status-dot"),
  status: ResourceStatus,
  label: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "StatusDot" });

const ChildTypeRef = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  pluralDisplayName: Schema.optionalKey(Schema.String),
  iconKey: Schema.optionalKey(Schema.String),
  /** The fields this type marked to show on a child's tile. */
  showcase: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })),
  ),
  supportsCreate: Schema.Boolean,
  /** Field schema, shipped only for child types that support update. */
  fields: Schema.optionalKey(Schema.Array(JsonObject)),
}).annotate({ identifier: "ChildTypeRef" });

const ChildResourceRef = Schema.Struct({
  id: ResourceId,
  displayName: Schema.String,
  resourceTypeId: Schema.String,
  pluginId: Schema.String,
  accountId: Uuid,
  status: Schema.optionalKey(StatusDot),
  /** Field bag, shipped only for types the detail view renders as a child table. */
  fields: Schema.optionalKey(JsonObject),
}).annotate({ identifier: "ChildResourceRef" });

const peerPaneStubFields = {
  tabLabel: Schema.String,
  pluginLogoSvg: Schema.String,
  peerPluginId: Schema.String,
};

const PeerPaneStub = Schema.Struct(peerPaneStubFields).annotate({ identifier: "PeerPaneStub" });

export const PeerPane = Schema.Struct({ ...peerPaneStubFields, schema: JsonObject }).annotate({
  identifier: "PeerPane",
});

const CredentialFormat = Schema.Struct({
  id: Schema.String.annotate({ description: "Passed back as `formatId` on export." }),
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  mediaType: Schema.Literals(["json", "text", "ini", "binary-base64"]).annotate({
    description:
      "How the credential body should be presented. `binary-base64` means `content` is base64.",
  }),
  filenameTemplate: Schema.optionalKey(
    Schema.String.annotate({
      description: "Suggested filename; `{resource}` is replaced with the resource's external id.",
    }),
  ),
}).annotate({ identifier: "CredentialFormat" });

const EditableField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: Schema.Literals([
    "string",
    "number",
    "boolean",
    "enum",
    "secret",
    "association",
    "password",
  ]),
  required: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  enumValues: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "EditableField" });

export const ResourceDetail = Schema.Struct({
  detailSchema: JsonObject.annotateKey({
    description: "Plugin-rendered DetailViewSchema. Free-form by design.",
  }),
  childResources: Schema.Array(ChildResourceRef),
  childTypes: Schema.Array(ChildTypeRef),
  pluginId: Schema.String,
  pluginLogoSvg: Schema.String,
  resourceId: ResourceId,
  accountId: Uuid,
  resourceTypeId: Schema.String,
  peerPanes: Schema.Array(PeerPane),
  peerIntegrationStubs: Schema.Array(PeerPaneStub),
  canDelete: Schema.Boolean,
  canEdit: Schema.Boolean,
  editableFields: Schema.Array(EditableField),
  credentialFormats: Schema.Array(CredentialFormat),
  supportsTerraformExport: Schema.Boolean,
  hasManifestEditor: Schema.Boolean,
  hasSecretVersions: Schema.Boolean,
  resourceDisplayName: Schema.String,
  resourceTypeLabel: Schema.String,
  resourceFields: JsonObject,
  hasSqlEditor: Schema.Boolean,
  hasStorageBrowser: Schema.Boolean,
  hasArtifactRegistry: Schema.Boolean,
  hasKvBrowser: Schema.Boolean,
  hasKvConsole: Schema.Boolean,
  kvDriverName: Schema.optionalKey(Schema.String),
  isMongoDb: Schema.Boolean,
  hasDockerActions: Schema.Boolean,
  hasSshTerminal: Schema.Boolean,
  hasSftpBrowser: Schema.Boolean,
  supportsSshInstall: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether the generic SSH service installer can target this resource.",
    }),
  ),
  sshHost: Schema.NullOr(Schema.String),
  sshPrivateHost: Schema.optionalKey(Schema.NullOr(Schema.String)),
  defaultSshUsername: Schema.NullOr(Schema.String),
  containerId: Schema.String,
  databaseName: Schema.String,
  storageBucketName: Schema.String,
  supportsMetrics: Schema.Boolean,
  schedulable: Schema.Boolean.annotate({
    description:
      "The type declares lifecycle start/stop actions, so this resource can carry a sleep/wake schedule.",
  }),
}).annotate({ identifier: "ResourceDetail" });

export const Manifest = Schema.Struct({ manifest: Schema.String }).annotate({
  identifier: "Manifest",
});

const ApplyManifestRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  manifest: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "ApplyManifestRequest" });

const ImportYamlRequest = Schema.Struct({
  accountId: Uuid,
  yaml: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "ImportYamlRequest" });

const DescribeRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "DescribeRequest" });

export const DescribeResponse = Schema.Struct({ text: Schema.String }).annotate({
  identifier: "DescribeResponse",
});

const LogsRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: Schema.optionalKey(ResourceId),
  tailLines: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  container: Schema.optionalKey(Schema.String),
  previous: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LogsRequest" });

export const LogsResponse = Schema.Struct({
  text: Schema.String.annotate({
    description: "Raw log text; each entry keeps its trailing newline.",
  }),
  containers: Schema.Array(Schema.String).annotate({
    description: "Container names available for this resource, drives the container picker.",
  }),
  activeContainer: Schema.String.annotate({ description: "Container `text` was read from." }),
}).annotate({ identifier: "LogsResponse" });

const SecretVersion = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["enabled", "disabled", "destroyed"]),
  createdAt: Schema.String.annotate({ description: "ISO-8601." }),
  destroyedAt: Schema.optionalKey(
    Schema.String.annotate({ description: "Set only when destroyed." }),
  ),
  isLatest: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "SecretVersion" });

export const SecretVersionsResponse = Schema.Struct({
  versions: Schema.Array(SecretVersion),
}).annotate({ identifier: "SecretVersionsResponse" });

const SecretAccessRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  versionId: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "SecretAccessRequest" });

export const SecretAccessResponse = Schema.Struct({ value: Schema.String }).annotate({
  identifier: "SecretAccessResponse",
});

const SecretAddRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  value: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "SecretAddRequest" });

const SecretModifyRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  versionId: Schema.String,
  action: Schema.Literals(["enable", "disable", "destroy"]),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "SecretModifyRequest" });

export const SecretVersionResponse = Schema.Struct({ version: SecretVersion }).annotate({
  identifier: "SecretVersionResponse",
});

const InvokeActionRequest = Schema.Struct({
  pluginId: Schema.String,
  accountId: Uuid,
  resourceTypeId: Schema.String,
  resourceId: ResourceId,
  actionId: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "InvokeActionRequest" });

const NoSqlCommandRequest = Schema.Struct({
  pluginId: Schema.String,
  accountId: Uuid,
  resourceTypeId: Schema.String,
  resourceId: ResourceId,
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "NoSqlCommandRequest" });

export const NoSqlCommandResult = Schema.Struct({ result: JsonObject });

const AttachRequest = Schema.Struct({
  pluginId: Schema.String,
  accountId: Uuid,
  sourceTypeId: Schema.String,
  sourceResourceId: ResourceId,
  targetTypeId: Schema.String,
  targetResourceId: ResourceId,
}).annotate({ identifier: "AttachRequest" });

const ExportCredentialRequest = Schema.Struct({
  resourceId: ResourceId,
  accountId: Uuid,
  formatId: Schema.String,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "ExportCredentialRequest" });

export const CredentialExport = Schema.Struct({
  content: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  /** Structured parts rendered as a key/value table (e.g. key id + secret). */
  fields: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        value: Schema.String,
        sensitive: Schema.optionalKey(Schema.Boolean),
        hint: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  warning: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CredentialExport" });

const ExportTerraformRequest = Schema.Struct({
  resourceId: ResourceId,
  accountId: Uuid,
}).annotate({ identifier: "ExportTerraformRequest" });

const CreateResourceRequest = Schema.Struct({
  accountId: Uuid,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "CreateResourceRequest" });

/** A step after the provider's create that did not work out, shown as a toast. */
const ResourceWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "ResourceWarning" });

export const CreateResourceResponse = Schema.Struct({
  id: ResourceId,
  displayName: Schema.String,
  warnings: Schema.optionalKey(Schema.Array(ResourceWarning)),
}).annotate({ identifier: "CreateResourceResponse" });

const UpdateResourceRequest = Schema.Struct({
  accountId: Uuid,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: ResourceId,
  fields: Schema.Record(Schema.String, Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "UpdateResourceRequest" });

export const UpdateResourceResponse = Schema.Struct({
  id: ResourceId,
  displayName: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "UpdateResourceResponse" });

const CreateConfigRequest = Schema.Struct({
  accountId: Uuid,
  resourceTypeId: Schema.String,
  pluginId: Schema.optionalKey(Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "CreateConfigRequest" });

const PickerResourcesRequest = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      outputKey: Schema.String,
    }),
  ),
  accountId: Uuid,
  /**
   * Optional regional scope. When set, plugins that fan out across regions
   * (e.g. AWS) restrict the listing to this region. Used by create forms to
   * avoid loading resources from every region for a region-locked field.
   */
  regionHint: Schema.optionalKey(Schema.String),
  /**
   * When true, search every account in the org whose plugin matches a source
   * instead of only `accountId`: used by reference-mode pickers where the
   * target usually lives in another account. Labels are suffixed with the
   * owning account name.
   */
  crossAccount: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PickerResourcesRequest" });

const PickerResource = Schema.Struct({
  id: ResourceId,
  label: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  outputKey: Schema.String,
  outputValue: Schema.String,
}).annotate({ identifier: "PickerResource" });

export const PickerResources = Schema.Array(PickerResource);

const CreatePricingRequest = Schema.Struct({
  accountId: Uuid,
  resourceTypeId: Schema.String,
  regionId: Schema.optionalKey(Schema.String),
  sizes: Schema.mutable(
    Schema.Array(
      Schema.Struct({ id: Schema.String, vcpus: Schema.Finite, memoryMb: Schema.Finite }),
    ),
  ),
  pluginId: Schema.optionalKey(Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "CreatePricingRequest" });

export const CreatePricing = Schema.Record(Schema.String, JsonObject);

const CostEstimateRequest = Schema.Struct({
  accountId: Uuid,
  resourceTypeId: Schema.String,
  /**
   * Field values to price, keyed the way the create form keys them. Omit it
   * together with `resourceId` to price an existing resource from its stored
   * fields; supply both to price a proposed edit of one.
   */
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** An existing resource to price. Its stored fields seed the estimate. */
  resourceId: Schema.optionalKey(ResourceId),
  pluginId: Schema.optionalKey(Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "CostEstimateRequest" });

const CostEstimateLineItem = Schema.Struct({
  label: Schema.String,
  monthlyAmount: Schema.Finite,
  detail: Schema.optionalKey(Schema.String),
  quantity: Schema.optionalKey(Schema.Finite),
  unit: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CostEstimateLineItem" });

const CostEstimate = Schema.Struct({
  monthlyAmount: Schema.Finite,
  currency: Schema.String,
  lineItems: Schema.Array(CostEstimateLineItem),
  partial: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "CostEstimate" });

export const CostEstimateResponse = Schema.Struct({
  estimate: Schema.NullOr(CostEstimate),
  carbon: Schema.NullOr(ResourceCarbonEstimate).annotate({
    description:
      "Estimated monthly CO2e of the same configuration, beside its price. Null for a " +
      "peer resource or when the size catalogue could not be read.",
  }),
});

const FieldActionRequest = Schema.Struct({
  accountId: Uuid,
  resourceTypeId: Schema.String,
  fieldKey: Schema.String,
  actionId: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
  /**
   * Values from the action's inline mini-form (declared via
   * `FieldAction.formFields`). Kept separate from `fields` so the action's
   * own field keys can't collide with outer create-form keys.
   */
  actionFields: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  pluginId: Schema.optionalKey(Schema.String),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "FieldActionRequest" });

export const FieldActionResponse = Schema.Struct({
  value: Schema.String,
  option: Schema.optionalKey(Schema.Struct({ id: Schema.String, label: Schema.String })),
}).annotate({ identifier: "FieldActionResponse" });

const PeerPanesRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "PeerPanesRequest" });

export const PeerPanes = Schema.Array(PeerPane);

const MetricsRequest = Schema.Struct({
  accountId: Uuid,
  resourceId: ResourceId,
  startMs: Schema.optionalKey(Schema.Int),
  endMs: Schema.optionalKey(Schema.Int),
  parentResourceId: Schema.optionalKey(ResourceId),
}).annotate({ identifier: "MetricsRequest" });

const MetricSeries = Schema.Struct({
  label: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  points: Schema.Array(
    Schema.Struct({
      timestamp: Schema.Finite.annotate({ description: "Unix epoch milliseconds." }),
      value: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "MetricSeries" });

export const MetricsResponse = Schema.Struct({ series: Schema.Array(MetricSeries) }).annotate({
  identifier: "MetricsResponse",
});

const SshInstallAccount = Schema.Struct({
  accountId: Uuid,
  displayName: Schema.String,
  pluginId: Schema.String,
  serviceName: Schema.String,
  description: Schema.String,
  logoSvg: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SshInstallAccount" });

export const SshInstallAccounts = Schema.Array(SshInstallAccount);

const SshInstallRequest = Schema.Struct({
  installerAccountId: Uuid,
  target: Schema.Struct({
    accountId: Uuid,
    resourceTypeId: Schema.String.check(minLength(1)),
    resourceId: ResourceId,
  }),
  sshKeyId: Schema.optionalKey(Uuid),
  username: Schema.optionalKey(Schema.String.check(minLength(1), maxLength(64))),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
}).annotate({ identifier: "SshInstallRequest" });

export const SshInstallResult = Schema.Struct({
  message: Schema.String,
  address: Schema.optionalKey(Schema.String),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  ref: Schema.optionalKey(
    Schema.String.annotate({
      description: "Opaque, plugin-owned handle to what was installed (e.g. a tailnet device id).",
    }),
  ),
}).annotate({ identifier: "SshInstallResult" });

/**
 * The 409 an SSH connection to a host whose key is not yet trusted answers
 * with, the body every SSH route shares (`SshHostKeyTrustRequired`): clients
 * recognise the `error` code and prompt the user to trust the fingerprint.
 * The install has always documented it under its own component name and
 * response description, which this keeps.
 */
const SshInstallTrustRequired = SshHostKeyTrustRequired.annotate({
  identifier: "SshInstallTrustRequired",
  description: "SSH host-key trust is required before installation can begin",
});

const TagPolicyViolation = Schema.Struct({
  key: Schema.String,
  reason: Schema.Literals(["missing", "value_not_allowed"]),
  value: Schema.optionalKey(Schema.String),
  allowedValues: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "TagPolicyViolation" });

/**
 * The 422 a create answers when the org tag policy blocks it. Same protocol as
 * `ChangeFreezeBlocked` (423): a caller holding `tag-policy:override` may retry
 * with `x-tag-policy-override: true`; blocks and overrides are audit-logged.
 */
export class TagPolicyBlocked extends Schema.Error<TagPolicyBlocked>(
  "infrawrench/http/TagPolicyBlocked",
)(
  {
    error: Schema.String,
    code: Schema.Literal("tag_policy_unmet"),
    violations: Schema.Array(TagPolicyViolation),
    requiredTags: Schema.Array(RequiredTag),
  },
  {
    httpApiStatus: 422,
    identifier: "TagPolicyBlocked",
    description:
      "Blocked by the organization's tag policy: the submitted fields are missing a required tag " +
      "(or carry a disallowed value). Retry with the `x-tag-policy-override: true` header if you " +
      "hold `tag-policy:override`; both blocks and overrides are audit-logged.",
  },
) {}

/*
 * The undocumented endpoints' bodies, as the panels send them.
 */
const ResourceTarget = {
  pluginId: Schema.String,
  accountId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: Schema.String,
  parentResourceId: Schema.optionalKey(Schema.String),
};

const ChatStreamRequest = Schema.Struct({
  ...ResourceTarget,
  messages: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["system", "user", "assistant"]),
        content: Schema.String,
      }),
    ),
  ),
  model: Schema.optionalKey(Schema.String),
});

const PublishMessageRequest = Schema.Struct({
  ...ResourceTarget,
  payload: Schema.Struct({
    body: Schema.String,
    extras: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
    ),
  }),
});

const SynthesizeSpeechRequest = Schema.Struct({
  ...ResourceTarget,
  payload: Schema.Struct({
    text: Schema.String,
    voiceId: Schema.optionalKey(Schema.String),
    modelId: Schema.optionalKey(Schema.String),
  }),
});

const TranscribeAudioRequest = Schema.Struct({
  ...ResourceTarget,
  payload: Schema.Struct({
    audioBase64: Schema.String,
    mimeType: Schema.String,
    fileName: Schema.optionalKey(Schema.String),
    modelId: Schema.optionalKey(Schema.String),
    language: Schema.optionalKey(Schema.String),
  }),
});

const TunnelSshAttachRequest = Schema.Struct({
  tunnel: Schema.Struct({
    accountId: Schema.String,
    pluginId: Schema.String,
    resourceId: Schema.String,
  }),
  host: Schema.Struct({
    accountId: Schema.String,
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    resourceId: Schema.String,
  }),
  hostname: Schema.String,
  zoneId: Schema.String,
  serviceType: Schema.optionalKey(Schema.Literals(["http", "https", "ssh", "tcp"])),
  port: Schema.optionalKey(Schema.String),
  sshUsername: Schema.String,
  sshKeyId: Schema.optionalKey(Schema.String),
});

/** `:pluginId` / `:typeId`, documented as the registry's enums. */
const PluginParams = { orgId: OrgParams.orgId, pluginId: PluginId } as const;
const PluginTypeParams = { ...PluginParams, typeId: ResourceTypeId } as const;

/**
 * `resourceId` / `accountId` read as they arrived: a missing one is the
 * handler's own 400 ("Missing resourceId"), as it always was.
 */
const resourceQuery = {
  resourceId: Schema.optionalKey(documentedAs(ResourceId)),
  accountId: Schema.optionalKey(documentedAs(Uuid)),
  parentResourceId: Schema.optionalKey(ResourceId),
} as const;

export class ResourcesGroup extends HttpApiGroup.make("resources")
  .add(
    HttpApiEndpoint.get("sshInstallAccounts", "/ssh-install/accounts", {
      params: OrgParams,
      success: SshInstallAccounts,
      error: Forbidden,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List service accounts that can enroll an SSH server")
      .annotate(SuccessDescription, "Available service accounts"),
    // Two gates, write then execute, checked in that order by the handler;
    // the body is decoded strictly after both, refusing anything that would
    // steer the connection (a host, a command).
    HttpApiEndpoint.post("sshInstall", "/ssh-install", {
      params: OrgParams,
      payload: SshInstallRequest,
      success: SshInstallResult,
      error: [BadRequest, Forbidden, SshInstallTrustRequired, ChangeFreezeBlocked],
    })
      .annotate(DocumentedPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Install and enroll a service on an existing SSH target")
      .annotate(
        OpenApi.Description,
        "Requires resources:write and resources:execute. Uses the selected target's saved SSH connection or an org SSH key. Respects change freezes and host-key trust. Enrollment credentials never appear in the response or audit log.",
      )
      .annotate(SuccessDescription, "Installation result"),
    HttpApiEndpoint.get("detail", "/:pluginId/:typeId/detail", {
      params: PluginTypeParams,
      query: {
        resourceId: resourceQuery.resourceId,
        accountId: Schema.optionalKey(Uuid),
        parentResourceId: resourceQuery.parentResourceId,
        includePeerPanes: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["true", "false"]).annotate({
              description: "Default true. If false, peer panes are returned as stubs.",
            }),
          ),
        ),
      },
      success: ResourceDetail,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Full resource detail page payload")
      .annotate(
        OpenApi.Description,
        "Performs a live `listResources` against the provider, falls back to DB on failure, and returns the plugin's `renderDetail` schema plus host-derived flags (SQL/KV/SSH availability, child resources, peer panes, etc).",
      )
      .annotate(SuccessDescription, "Detail")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId"])),
    HttpApiEndpoint.get("getManifest", "/:pluginId/:typeId/manifest", {
      params: PluginTypeParams,
      query: resourceQuery,
      success: Manifest,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Fetch the raw manifest (YAML/JSON) for a resource")
      .annotate(SuccessDescription, "Manifest")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId", "accountId"])),
    HttpApiEndpoint.post("applyManifest", "/:pluginId/:typeId/manifest", {
      params: PluginTypeParams,
      payload: ApplyManifestRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Apply an edited manifest to a resource")
      .annotate(SuccessDescription, "Applied"),
    HttpApiEndpoint.post("importYaml", "/:pluginId/import-yaml", {
      params: PluginParams,
      payload: ImportYamlRequest,
      success: JsonObject,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Bulk-import resources from YAML (kubectl apply -f equivalent)")
      .annotate(SuccessDescription, "Import result"),
    HttpApiEndpoint.post("describe", "/:pluginId/:typeId/describe", {
      params: PluginTypeParams,
      payload: DescribeRequest,
      success: DescribeResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get human-readable describe text for a resource")
      .annotate(SuccessDescription, "Describe text"),
    HttpApiEndpoint.post("logs", "/:pluginId/:typeId/logs", {
      params: PluginTypeParams,
      payload: LogsRequest,
      success: LogsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Fetch logs for a resource")
      .annotate(SuccessDescription, "Logs"),
    HttpApiEndpoint.get("listSecretVersions", "/:pluginId/:typeId/secret-versions", {
      params: PluginTypeParams,
      query: resourceQuery,
      success: SecretVersionsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "List secret versions for a versioned-secret resource")
      .annotate(SuccessDescription, "Versions")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId", "accountId"])),
    HttpApiEndpoint.post("accessSecretVersion", "/:pluginId/:typeId/secret-versions/access", {
      params: PluginTypeParams,
      payload: SecretAccessRequest,
      success: SecretAccessResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "Reveal the plaintext value of a specific version (one-time)")
      .annotate(SuccessDescription, "Plaintext"),
    HttpApiEndpoint.post("addSecretVersion", "/:pluginId/:typeId/secret-versions/add", {
      params: PluginTypeParams,
      payload: SecretAddRequest,
      success: SecretVersionResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Add a new secret version")
      .annotate(SuccessDescription, "Added"),
    HttpApiEndpoint.post("modifySecretVersion", "/:pluginId/:typeId/secret-versions/modify", {
      params: PluginTypeParams,
      payload: SecretModifyRequest,
      success: SecretVersionResponse,
      error: [BadRequest, NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "secrets:write")
      .annotate(OpenApi.Summary, "Enable/disable/destroy a secret version")
      .annotate(SuccessDescription, "Modified"),
    HttpApiEndpoint.delete("delete", "/:pluginId/:typeId", {
      params: PluginTypeParams,
      query: resourceQuery,
      success: Ok,
      error: [BadRequest, NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:delete")
      .annotate(OpenApi.Summary, "Delete a resource via the plugin")
      .annotate(SuccessDescription, "Deleted")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId", "accountId"])),
    HttpApiEndpoint.post("invokeAction", "/invoke-action", {
      params: OrgParams,
      payload: InvokeActionRequest,
      success: Ok,
      error: [BadRequest, NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Invoke a plugin-defined action on a resource")
      .annotate(
        OpenApi.Description,
        "Actions the plugin marks `destructive: true` in its detail schema are blocked with `423` while an org change freeze is in effect.",
      )
      .annotate(SuccessDescription, "Invoked"),
    HttpApiEndpoint.post("nosqlCommand", "/nosql-command", {
      params: OrgParams,
      payload: NoSqlCommandRequest,
      success: NoSqlCommandResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a NoSQL document-browser command (e.g. MongoDB shell)")
      .annotate(SuccessDescription, "Command result"),
    // NDJSON, one `ChatStreamEvent` per line, flushed as the plugin yields.
    HttpApiEndpoint.post("chatStream", "/chat-stream", {
      params: OrgParams,
      payload: ChatStreamRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("publishMessage", "/publish-message", {
      params: OrgParams,
      payload: PublishMessageRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("synthesizeSpeech", "/synthesize-speech", {
      params: OrgParams,
      payload: SynthesizeSpeechRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("transcribeAudio", "/transcribe-audio", {
      params: OrgParams,
      payload: TranscribeAudioRequest,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("attach", "/attach", {
      params: OrgParams,
      payload: AttachRequest,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Attach a resource onto another (e.g. disk → VM)")
      .annotate(SuccessDescription, "Attached"),
    HttpApiEndpoint.post("tunnelSshAttach", "/tunnel-ssh-attach", {
      params: OrgParams,
      payload: TunnelSshAttachRequest,
      success: Undocumented,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("exportCredential", "/:pluginId/:typeId/export-credential", {
      params: PluginTypeParams,
      payload: ExportCredentialRequest,
      success: CredentialExport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(InvalidRequestMessage, "Missing resourceId, accountId, or formatId")
      .annotate(OpenApi.Summary, "Export a credential file for a resource (one-time reveal)")
      .annotate(SuccessDescription, "Credential file"),
    HttpApiEndpoint.post("exportTerraform", "/:pluginId/:typeId/export-terraform", {
      params: PluginTypeParams,
      payload: ExportTerraformRequest,
      success: TerraformExport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(InvalidRequestMessage, "Missing resourceId or accountId")
      .annotate(
        OpenApi.Summary,
        "Generate Terraform HCL for a resource (and its direct children) from stored state",
      )
      .annotate(SuccessDescription, "Generated Terraform configuration"),
    HttpApiEndpoint.post("create", "/create", {
      params: OrgParams,
      payload: CreateResourceRequest,
      success: CreateResourceResponse,
      error: [BadRequest, NotFound, TagPolicyBlocked, InternalServerError],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a new resource via its plugin")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("update", "/update", {
      params: OrgParams,
      payload: UpdateResourceRequest,
      success: UpdateResourceResponse,
      error: [BadRequest, NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a resource via its plugin")
      .annotate(
        OpenApi.Description,
        "Applies the supplied field changes upstream and persists the refreshed fields/display name to the DB. The body's `fields` map only carries the keys the caller actually changed. Blocked with `423` while an org change freeze is in effect (this is also the path that applies right-sizing recommendations); every applied update is audit-logged.",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.post("createConfig", "/create-config", {
      params: OrgParams,
      payload: CreateConfigRequest,
      success: JsonObject,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Get the dynamic create form for a resource type")
      .annotate(
        OpenApi.Description,
        "Calls the plugin's `getCreateConfig`. The returned `CreateResourceConfig` is plugin-shaped, see `JsonObject`.",
      )
      .annotate(SuccessDescription, "Config"),
    HttpApiEndpoint.post("pickerResources", "/picker-resources", {
      params: OrgParams,
      payload: PickerResourcesRequest,
      success: PickerResources,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Fetch options for a `resource-picker` field")
      .annotate(SuccessDescription, "Options"),
    HttpApiEndpoint.post("createPricing", "/create-pricing", {
      params: OrgParams,
      payload: CreatePricingRequest,
      success: CreatePricing,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Pricing per size for a create form")
      .annotate(
        SuccessDescription,
        "Map of `sizeId → pricing`. Empty object when the plugin doesn't support pricing.",
      ),
    HttpApiEndpoint.post("fieldAction", "/field-action", {
      params: OrgParams,
      payload: FieldActionRequest,
      success: FieldActionResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Execute an in-form field action (e.g. generate an IAM role)")
      .annotate(
        OpenApi.Description,
        "Calls the plugin's `executeFieldAction`. Returns `{ value }` to assign to the field; for `select` fields the optional `option` should be spliced into the options list so the new value can be displayed.",
      )
      .annotate(SuccessDescription, "Action result"),
    HttpApiEndpoint.post("costEstimate", "/cost-estimate", {
      params: OrgParams,
      payload: CostEstimateRequest,
      success: CostEstimateResponse,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Estimated monthly cost of a configuration")
      .annotate(
        OpenApi.Description,
        "Calls the plugin's `estimateCost` and returns a monthly total with the line items behind " +
          "it. Price a proposed resource by passing `fields`, an existing one by passing " +
          "`resourceId`, or a proposed change to an existing one by passing both; `fields` is " +
          "merged over the resource's stored fields, so the caller only sends what changed. " +
          "`estimate` is null when the plugin cannot price the configuration; that is not the same " +
          "as an estimate of zero, and it should not be rendered as one.",
      )
      .annotate(
        SuccessDescription,
        "Estimate, or null when the plugin cannot price this configuration",
      ),
    HttpApiEndpoint.post("peerPanes", "/:pluginId/:typeId/peer-panes", {
      params: PluginTypeParams,
      payload: PeerPanesRequest,
      success: PeerPanes,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Lazy-fetch peer-integration panes for a resource")
      .annotate(SuccessDescription, "Peer panes"),
    HttpApiEndpoint.post("metrics", "/:pluginId/:typeId/metrics", {
      params: PluginTypeParams,
      payload: MetricsRequest,
      success: MetricsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Fetch metric series for a resource")
      .annotate(
        OpenApi.Description,
        "Historical points from the metrics store when the resource has accumulated any " +
          "(resources pinned to a dashboard are polled continuously); otherwise the series are " +
          "fetched live from the provider on demand.",
      )
      .annotate(SuccessDescription, "Metrics"),
  )
  .prefix("/api/org/:orgId/resources")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Resources") {}

export class ResourcesApi extends withApiDefaults(HttpApi.make("resources").add(ResourcesGroup)) {}

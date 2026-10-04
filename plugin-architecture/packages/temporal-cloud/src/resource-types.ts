import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Temporal Cloud resource types. Each lists from one Cloud Ops API endpoint
 * (named above it); field names follow the published OpenAPI document.
 */

const ro = { required: false, editable: false } as const;

/** `GET /cloud/account` + `GET /cloud/current-identity`. */
export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  description:
    "The Temporal Cloud account the API key belongs to: its id, the identity and role of the key, the metrics endpoint, and the regions namespaces can be placed in.",
  fields: [
    f("accountId", "Account ID", { editable: false }),
    f("state", "State", ro),
    f("identity", "API Key Identity", ro),
    f("identityRole", "Key Role", ro),
    f("metricsUri", "Legacy Metrics Endpoint", ro),
    f("namespaceCount", "Namespaces", { kind: "number", ...ro }),
    f("regions", "Available Regions", ro),
  ],
  outputs: [o("accountId", "Account ID")],
  accountRoot: true,
  iconKey: "account",
});

/** `GET /cloud/namespaces`. */
export const NamespaceResourceType = rt({
  name: "Namespace",
  id: "namespace",
  description:
    "A Temporal Cloud namespace: the unit of isolation for workflows, with its own region, retention period, authentication and endpoints. Edit retention, delete protection, API key authentication, the codec server and tags; add or rename custom search attributes; add a replica region and fail over a multi-region namespace; and chart actions, workflow outcomes, latency and backlog.",
  fields: [
    f("namespaceId", "Namespace ID", { editable: false }),
    f("name", "Name", { editable: false }),
    f("description", "Description", {
      required: false,
      description: "Up to 255 printable ASCII characters.",
    }),
    f("retentionDays", "Retention (days)", {
      kind: "number",
      required: true,
      description:
        "How long closed workflow histories are kept, from 1 to 90 days. A change applies to workflows that close after it; longer retention raises retained storage cost.",
    }),
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "When on, the namespace cannot be deleted until protection is turned off.",
    }),
    f("apiKeyAuth", "API Key Authentication", {
      kind: "boolean",
      required: false,
      description:
        "Allow clients to connect with API keys. Turning it off disconnects every client that uses one.",
    }),
    f("codecServerEndpoint", "Codec Server Endpoint", {
      required: false,
      description:
        "HTTPS URL of the codec server the Temporal Cloud UI uses to decode payloads. Leave empty for none.",
    }),
    f("taskQueueFairness", "Task Queue Fairness", { kind: "boolean", required: false }),
    f("tags", "Tags", {
      required: false,
      description:
        "Comma-separated key=value pairs, up to 10, for example team=payments, env=prod. Keys and values use lowercase letters, digits, and . _ - @. Tags flow into the billing report, so they break cost down too.",
    }),
    f("state", "State", ro),
    f("regions", "Regions", ro),
    f("region", "Active Region", ro),
    f("multiRegion", "High Availability", { kind: "boolean", ...ro }),
    f("mtlsAuth", "mTLS Authentication", { kind: "boolean", ...ro }),
    f("grpcAddress", "gRPC Endpoint (API key)", ro),
    f("mtlsGrpcAddress", "gRPC Endpoint (mTLS)", ro),
    f("webAddress", "Web UI", ro),
    f("apsLimit", "Actions per Second Limit", { kind: "number", ...ro }),
    f("capacityMode", "Capacity Mode", ro),
    f("searchAttributes", "Custom Search Attributes", ro),
    f("projectId", "Project", ro),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [
    o("namespaceId", "Namespace ID"),
    o("grpcAddress", "gRPC Endpoint (API key)"),
    o("mtlsGrpcAddress", "gRPC Endpoint (mTLS)"),
    o("webAddress", "Web UI"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "database",
});

/** `GET /cloud/namespaces/{namespace}/export-sinks`, per namespace. */
export const ExportSinkResourceType = rt({
  name: "Export Sink",
  id: "export-sink",
  parentTypeId: "namespace",
  showInSidebar: true,
  description:
    "A workflow history export sink: closed workflow histories from the namespace are written to your S3 or GCS bucket. Shows health and the last export, enables or disables it, edits the destination and validates access.",
  fields: [
    f("name", "Name", { editable: false }),
    f("namespaceId", "Namespace", { editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("destination", "Destination", ro),
    f("bucketName", "Bucket", { required: false }),
    f("bucketRegion", "Bucket Region", { required: false }),
    f("roleName", "IAM Role Name (S3)", { required: false }),
    f("awsAccountId", "AWS Account ID (S3)", { required: false }),
    f("kmsArn", "KMS Key ARN (S3)", { required: false }),
    f("gcpProjectId", "GCP Project ID (GCS)", { required: false }),
    f("serviceAccountId", "Service Account ID (GCS)", { required: false }),
    f("health", "Health", ro),
    f("errorMessage", "Error", ro),
    f("state", "State", ro),
    f("latestExportAt", "Last Export", ro),
    f("lastHealthCheckAt", "Last Health Check", ro),
  ],
  outputs: [o("name", "Sink Name")],
  dependsOn: [{ fieldKey: "namespaceId", targetTypeId: "namespace", label: "exports" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "storage",
});

/** `GET /cloud/users`. */
export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "A person in the Temporal Cloud account with an account role and per-namespace permissions. Invite users, change their account role, grant or change namespace access, and remove them.",
  fields: [
    f("email", "Email", { editable: false }),
    f("accountRole", "Account Role", {
      kind: "enum",
      required: true,
      enumValues: ["admin", "developer", "financeadmin", "read", "metricsread"],
      description:
        "admin manages everything except owners; developer creates namespaces and Nexus endpoints; financeadmin reads and manages billing; read is read-only; metricsread can only read metrics. Owners are managed in Temporal Cloud.",
    }),
    f("namespaceAccess", "Namespace Access", ro),
    f("customRoles", "Custom Roles", ro),
    f("state", "State", ro),
    f("invitedAt", "Invited", ro),
    f("inviteExpiresAt", "Invitation Expires", ro),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  principalRole: {
    role: "user",
    createdKey: "createdAt",
    adminIndicatorKey: "accountRole",
    adminValues: ["owner", "admin"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

/** `GET /cloud/service-accounts`. */
export const ServiceAccountResourceType = rt({
  name: "Service Account",
  id: "service-account",
  description:
    "A machine identity in the Temporal Cloud account. Account-scoped service accounts carry an account role plus namespace permissions; namespace-scoped ones are bound to a single namespace. Create, rename, change roles and access, and delete.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("accountRole", "Account Role", {
      kind: "enum",
      required: false,
      enumValues: ["", "admin", "developer", "financeadmin", "read", "metricsread"],
      description: "Ignored for namespace-scoped service accounts.",
    }),
    f("scope", "Scope", ro),
    f("scopedNamespace", "Scoped Namespace", ro),
    f("namespaceAccess", "Namespace Access", ro),
    f("state", "State", ro),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [o("serviceAccountId", "Service Account ID")],
  principalRole: {
    role: "service-account",
    createdKey: "createdAt",
    adminIndicatorKey: "accountRole",
    adminValues: ["owner", "admin"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

/** `GET /cloud/api-keys`. Metadata only: the secret is shown once, at creation, in Temporal Cloud. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "A Temporal Cloud API key owned by a user or a service account. Listed with owner, expiry and state; disable or enable it, change its name or description, or delete it. The secret itself is never shown again after creation.",
  fields: [
    f("displayName", "Name"),
    f("description", "Description", { required: false }),
    f("ownerType", "Owner Type", ro),
    f("owner", "Owner", ro),
    f("disabled", "Disabled", { kind: "boolean", ...ro }),
    f("expiresAt", "Expires", ro),
    f("state", "State", ro),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    parentKey: "owner",
    revokeActionId: "disable",
  },
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

/** `GET /cloud/nexus/endpoints`. */
export const NexusEndpointResourceType = rt({
  name: "Nexus Endpoint",
  id: "nexus-endpoint",
  description:
    "A Nexus endpoint: a stable name other namespaces call to reach operations served by workers on a target namespace and task queue. Create, retarget, change which namespaces may call it, and delete.",
  fields: [
    f("name", "Name", {
      description: "Unique in the account: letters, digits and hyphens, starting with a letter.",
    }),
    f("targetNamespace", "Target Namespace", {
      description: "Namespace ID whose workers handle the endpoint's operations.",
    }),
    f("taskQueue", "Target Task Queue"),
    f("allowedCallers", "Allowed Caller Namespaces", {
      required: false,
      description: "Comma-separated namespace IDs that may call this endpoint.",
    }),
    f("description", "Description", { required: false }),
    f("state", "State", ro),
    f("createdAt", "Created", ro),
    f("modifiedAt", "Modified", ro),
  ],
  outputs: [o("endpointId", "Endpoint ID"), o("name", "Endpoint Name")],
  dependsOn: [{ fieldKey: "targetNamespace", targetTypeId: "namespace", label: "routes to" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "network",
});

/** `GET /cloud/connectivity-rules`. */
export const ConnectivityRuleResourceType = rt({
  name: "Connectivity Rule",
  id: "connectivity-rule",
  description:
    "A connectivity rule that controls how namespaces are reached: public internet (optionally with stable IPs) or a private connection such as AWS PrivateLink or GCP Private Service Connect. Create, attach to namespaces from the namespace page, and delete.",
  fields: [
    f("type", "Type", ro),
    f("region", "Region", ro),
    f("connectionId", "Connection ID", ro),
    f("gcpProjectId", "GCP Project ID", ro),
    f("stableIps", "Stable IPs", { kind: "boolean", ...ro }),
    f("namespaces", "Attached Namespaces", ro),
    f("state", "State", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("ruleId", "Rule ID")],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "network",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  NamespaceResourceType,
  ExportSinkResourceType,
  UserResourceType,
  ServiceAccountResourceType,
  ApiKeyResourceType,
  NexusEndpointResourceType,
  ConnectivityRuleResourceType,
];

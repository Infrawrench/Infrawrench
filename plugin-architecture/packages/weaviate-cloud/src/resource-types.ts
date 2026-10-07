import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * An account covers many clusters: those its Weaviate Cloud sign-in lists,
 * plus every endpoint in its credentials. Everything else is a child of a
 * cluster, and its external id starts with the cluster key (`<host>[:port]`):
 * `<key>/<collection>`, `<key>/<collection>/<tenant>`, `<key>/<alias>`,
 * `<key>/<backend>/<backup id>`, `<key>/<user id>`, `<key>/<role>`.
 */

export const TENANT_STATUSES = ["ACTIVE", "INACTIVE", "OFFLOADED", "OFFLOADING", "ONLOADING"];

/** Weaviate Cloud lifecycle statuses, from the wcloud CLI's `ClusterStatus`. */
export const LIFECYCLE_STATUSES = [
  "PENDING",
  "CREATING",
  "READY",
  "UPDATING",
  "FAILED",
  "WAITING",
  "DELETING",
  "DELETED",
  "EXPIRED",
  "SUSPENDED",
  "UNKNOWN",
];

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "cluster",
  description:
    "A Weaviate cluster: listed from the Weaviate Cloud organization or added by endpoint",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("hostname", "Host", { editable: false }),
    f("endpoint", "REST Endpoint", { required: false, editable: false }),
    f("hosting", "Hosting", { required: false, editable: false }),
    f("clusterId", "Cluster ID", { required: false, editable: false }),
    f("tier", "Tier", { required: false, editable: false }),
    f("lifecycle", "Lifecycle", {
      kind: "enum",
      enumValues: LIFECYCLE_STATUSES,
      required: false,
      editable: false,
      description: "Provisioning status reported by Weaviate Cloud",
    }),
    f("statusReason", "Status Reason", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("version", "Weaviate Version", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["HEALTHY", "DEGRADED", "UNAVAILABLE", "UNKNOWN", "UNREACHABLE", "NOT_CONNECTED"],
      editable: false,
      description: "Node health, read from the cluster itself",
    }),
    f("connection", "Connection", {
      required: false,
      editable: false,
      description: "Where Infrawrench gets this cluster's API key",
    }),
    f("nodes", "Nodes", { kind: "number", required: false, editable: false }),
    f("healthyNodes", "Healthy Nodes", { kind: "number", required: false, editable: false }),
    f("objectCount", "Objects", { kind: "number", required: false, editable: false }),
    f("shardCount", "Shards", { kind: "number", required: false, editable: false }),
    f("modules", "Modules", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("error", "Last Error", { required: false, editable: false }),
  ],
  outputs: [
    o("url", "REST URL"),
    o("grpcHost", "gRPC Host"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "The API key Infrawrench uses for this cluster",
    }),
  ],
  secretExportTemplates: [
    {
      id: "weaviate-env",
      displayName: "Weaviate environment variables",
      description: "WEAVIATE_URL and WEAVIATE_API_KEY",
      entries: [
        { envKey: "WEAVIATE_URL", outputKey: "url" },
        { envKey: "WEAVIATE_API_KEY", outputKey: "apiKey" },
      ],
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsDelete: false,
  supportsMetrics: true,
});

export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "A Weaviate collection (class): its vectorizer, properties, replication and tenancy",
  fields: [
    f("name", "Name", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("vectorizer", "Vectorizer", { required: false, editable: false }),
    f("vectorIndexType", "Vector Index", { required: false, editable: false }),
    f("namedVectors", "Named Vectors", { required: false, editable: false }),
    f("propertyCount", "Properties", { kind: "number", required: false, editable: false }),
    f("properties", "Property Types", { required: false, editable: false }),
    f("objectCount", "Objects", { kind: "number", required: false, editable: false }),
    f("shardCount", "Shards", { kind: "number", required: false, editable: false }),
    f("vectorQueueLength", "Vector Queue", { kind: "number", required: false, editable: false }),
    f("replicationFactor", "Replication Factor", {
      kind: "number",
      required: false,
      description: "Copies of each shard; needs at least that many nodes",
    }),
    f("multiTenancy", "Multi-Tenancy", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Fixed when the collection is created",
    }),
    f("autoTenantCreation", "Auto-Create Tenants", { kind: "boolean", required: false }),
    f("autoTenantActivation", "Auto-Activate Tenants", { kind: "boolean", required: false }),
  ],
  outputs: [o("collectionName", "Collection Name")],
  iconKey: "collection",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const TenantResourceType = rt({
  name: "Tenant",
  id: "tenant",
  parentTypeId: "collection",
  description: "A tenant of a multi-tenant collection",
  fields: [
    f("name", "Name", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("collection", "Collection", { editable: false }),
    f("activityStatus", "Activity", {
      kind: "enum",
      enumValues: TENANT_STATUSES,
      description:
        "ACTIVE is queryable, INACTIVE keeps data on local disk unloaded, OFFLOADED moves it to cloud storage (needs the offload module)",
    }),
  ],
  dependsOn: [{ fieldKey: "collection", targetTypeId: "collection", targetKey: "name" }],
  iconKey: "tenant",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
});

export const AliasResourceType = rt({
  name: "Alias",
  plural: "Aliases",
  id: "alias",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "An alternative name pointing at a collection, switchable without client changes",
  fields: [
    f("alias", "Alias", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("collection", "Collection", { description: "Pointing the alias elsewhere is instant" }),
  ],
  dependsOn: [{ fieldKey: "collection", targetTypeId: "collection", targetKey: "name" }],
  iconKey: "link",
  supportsCreate: true,
  supportsUpdate: true,
});

export const BackupResourceType = rt({
  name: "Backup",
  id: "backup",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "A backup taken through the cluster's backup module",
  fields: [
    f("backupId", "Backup ID", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("backend", "Backend", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "STARTED",
        "TRANSFERRING",
        "TRANSFERRED",
        "FINALIZING",
        "SUCCESS",
        "FAILED",
        "CANCELLING",
        "CANCELED",
      ],
      editable: false,
    }),
    f("collections", "Collections", { required: false, editable: false }),
    f("sizeGb", "Size (GiB)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Started", { required: false, editable: false }),
    f("completedAt", "Completed", { required: false, editable: false }),
  ],
  iconKey: "backup",
  supportsCreate: true,
  supportsDelete: false,
});

export const DbUserResourceType = rt({
  name: "Database User",
  id: "db-user",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "A database user with its own API key and RBAC roles",
  fields: [
    f("userId", "User ID", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("userType", "Type", { required: false, editable: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
    f("roles", "Roles", {
      required: false,
      description: "Comma-separated role names; editing replaces the assigned roles",
    }),
    f("keyPrefix", "Key Starts With", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [
    o("apiKey", "API Key", {
      sensitive: true,
      description: "Only for users created or rotated from Infrawrench; Weaviate shows a key once",
    }),
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    adminIndicatorKey: "roles",
    adminValues: ["admin", "root"],
    revokeActionId: "deactivate",
  },
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RoleResourceType = rt({
  name: "Role",
  id: "role",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "An RBAC role and the actions its permissions allow",
  fields: [
    f("name", "Name", { editable: false }),
    f("cluster", "Cluster", { required: false, editable: false }),
    f("builtIn", "Built In", { kind: "boolean", required: false, editable: false }),
    f("permissionCount", "Permissions", { kind: "number", required: false, editable: false }),
    f("actions", "Actions", { required: false, editable: false }),
  ],
  principalRole: { role: "role" },
  iconKey: "shield",
  pinnable: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  CollectionResourceType,
  TenantResourceType,
  AliasResourceType,
  BackupResourceType,
  DbUserResourceType,
  RoleResourceType,
];

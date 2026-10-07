import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const T = {
  database: "astra-database",
  region: "astra-region",
  keyspace: "astra-keyspace",
  collection: "astra-collection",
  accessEntry: "astra-access-entry",
  cdc: "astra-cdc",
  privateEndpoint: "astra-private-endpoint",
  snapshot: "astra-snapshot",
  pcuGroup: "astra-pcu-group",
  tenant: "astra-streaming-tenant",
  role: "astra-role",
  user: "astra-user",
  token: "astra-token",
} as const;

const DatabaseType = rt({
  name: "Database",
  id: T.database,
  description: "An Astra DB Serverless database, vector or non-vector, in one or more regions",
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("dbType", "Type", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Primary Region", { required: false, editable: false }),
    f("regions", "Regions", { required: false, editable: false }),
    f("tier", "Tier", { required: false, editable: false }),
    f("keyspace", "Default Keyspace", { required: false, editable: false }),
    f("keyspaces", "Keyspaces", { required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("replicationFactor", "Replication Factor", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("totalStorageGb", "Storage Limit (GB)", { kind: "number", required: false, editable: false }),
    f("usedStorageGb", "Storage Used (GB)", { kind: "number", required: false, editable: false }),
    f("accessListEnabled", "Access List Enforced", {
      kind: "boolean",
      required: false,
      description:
        "When on, only the addresses on the database's access list can reach its public endpoints.",
    }),
    f("accessListEntries", "Access List Entries", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("pcuGroupIds", "PCU Groups", { required: false, editable: false }),
    f("dataEndpointUrl", "API Endpoint", { required: false, editable: false }),
    f("cqlshUrl", "CQL Console", { required: false, editable: false }),
    f("grafanaUrl", "Grafana", { required: false, editable: false }),
    f("ownerId", "Owner", { required: false, editable: false }),
    f("orgId", "Organization ID", { required: false, editable: false }),
    f("message", "Message", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("databaseId", "Database ID"),
    o("apiEndpoint", "API Endpoint", { description: "Data API endpoint of the primary region" }),
    o("keyspace", "Default Keyspace"),
    o("region", "Primary Region"),
    o("secureBundleUrl", "Secure Connect Bundle URL", {
      sensitive: true,
      description: "Download link for the CQL driver bundle; valid for about five minutes",
    }),
  ],
  dependsOn: [{ fieldKey: "pcuGroupIds", targetTypeId: T.pcuGroup, label: "runs on" }],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "astra-data-api",
      displayName: "Data API",
      description: "ASTRA_DB_API_ENDPOINT and ASTRA_DB_KEYSPACE for the Data API clients",
      entries: [
        { envKey: "ASTRA_DB_API_ENDPOINT", outputKey: "apiEndpoint" },
        { envKey: "ASTRA_DB_KEYSPACE", outputKey: "keyspace" },
        { envKey: "ASTRA_DB_ID", outputKey: "databaseId" },
        { envKey: "ASTRA_DB_REGION", outputKey: "region" },
      ],
    },
  ],
  backupPolicy: { protectedBy: [T.snapshot] },
  postureChecks: [
    {
      id: "astra-db-open-public-endpoint",
      title: "Public endpoint open to any address",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "accessListEnabled", when: "falsy" }],
      reason:
        "The database's access list is not enforced, so any address with a valid token can reach its Data API and CQL endpoints. Add the networks your applications run in and enforce the list.",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "HIBERNATED" }],
    reason:
      "Hibernated after a long idle period. On the Free plan hibernated databases are scheduled for deletion; resume it if it is still needed, or terminate it.",
  },
});

const RegionType = rt({
  name: "Region",
  id: T.region,
  description: "One region (datacenter) of a database, with its endpoints and PCU group",
  parentTypeId: T.database,
  fields: [
    f("region", "Region", { editable: false }),
    f("cloud", "Cloud", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("datacenterId", "Datacenter ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("tier", "Tier", { required: false, editable: false }),
    f("classification", "Classification", { required: false, editable: false }),
    f("zone", "Zone", { required: false, editable: false }),
    f("pcuGroupId", "PCU Group", { required: false, editable: false }),
    f("dataEndpointUrl", "API Endpoint", { required: false, editable: false }),
    f("privateLinkService", "Private Link Service", { required: false, editable: false }),
    f("allowedPrincipals", "Private Link Principals", { required: false, editable: false }),
  ],
  outputs: [o("apiEndpoint", "API Endpoint")],
  dependsOn: [
    { fieldKey: "databaseId", targetTypeId: T.database, label: "region of" },
    { fieldKey: "pcuGroupId", targetTypeId: T.pcuGroup, label: "runs on" },
  ],
  iconKey: "globe",
  supportsCreate: true,
  supportsDelete: true,
});

const KeyspaceType = rt({
  name: "Keyspace",
  id: T.keyspace,
  description: "A keyspace (namespace) of a database",
  parentTypeId: T.database,
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("isDefault", "Default", { kind: "boolean", required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "databaseId", targetTypeId: T.database, label: "in" }],
  iconKey: "folder",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
});

const CollectionType = rt({
  name: "Collection",
  id: T.collection,
  description: "A Data API collection, optionally holding vectors",
  parentTypeId: T.keyspace,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("keyspace", "Keyspace", { editable: false }),
    f("vectorDimension", "Vector Dimension", { kind: "number", required: false, editable: false }),
    f("vectorMetric", "Similarity Metric", { required: false, editable: false }),
    f("vectorize", "Embedding Provider", { required: false, editable: false }),
    f("lexical", "Lexical Search", { kind: "boolean", required: false, editable: false }),
    f("rerank", "Reranking", { required: false, editable: false }),
    f("defaultIdType", "Default ID Type", { required: false, editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "keyspace",
      targetTypeId: T.keyspace,
      matchTemplate: "{databaseId}/{keyspace}",
      label: "in",
    },
  ],
  iconKey: "table",
  supportsCreate: true,
  supportsDelete: true,
});

const AccessEntryType = rt({
  name: "Access List Entry",
  id: T.accessEntry,
  plural: "Access List Entries",
  description: "An address or CIDR range allowed to reach a database's public endpoints",
  parentTypeId: T.database,
  fields: [
    f("address", "Address", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("description", "Description", { required: false }),
    f("updatedAt", "Last Updated", { required: false, editable: false }),
  ],
  iconKey: "shield",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: [
    {
      id: "astra-access-entry-open-world",
      title: "Access list allows every address",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "address", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "enabled", when: "truthy" },
      ],
      reason: "An enabled 0.0.0.0/0 entry makes the access list allow the whole internet.",
    },
  ],
});

const CdcType = rt({
  name: "CDC Table",
  id: T.cdc,
  description: "Change data capture from a table into an Astra Streaming tenant",
  parentTypeId: T.database,
  fields: [
    f("table", "Table", { editable: false }),
    f("keyspace", "Keyspace", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("tenants", "Streaming Tenants", { required: false, editable: false }),
    f("regions", "Regions", { required: false, editable: false }),
  ],
  iconKey: "stream",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
});

const PrivateEndpointType = rt({
  name: "Private Endpoint",
  id: T.privateEndpoint,
  description: "A private link endpoint from your cloud network into a database region",
  parentTypeId: T.region,
  fields: [
    f("endpointId", "Endpoint ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("datacenterId", "Datacenter ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("linkId", "Link ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const SnapshotType = rt({
  name: "Snapshot",
  id: T.snapshot,
  description: "An automatic backup snapshot of a database, usable as a clone source",
  parentTypeId: T.database,
  fields: [
    f("snapshotId", "Snapshot ID", { editable: false }),
    f("databaseId", "Database ID", { editable: false }),
    f("createdAt", "Taken", { required: false, editable: false }),
  ],
  iconKey: "backup",
  pinnable: false,
  supportsDelete: false,
  backupRole: { role: "snapshot", sourceKey: "databaseId" },
});

const PcuGroupType = rt({
  name: "PCU Group",
  id: T.pcuGroup,
  description:
    "Provisioned capacity units: reserved and burst compute that databases in a region run on",
  fields: [
    f("title", "Title"),
    f("pcuGroupId", "PCU Group ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("cloud", "Cloud", { editable: false }),
    f("region", "Region", { editable: false }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("provisionType", "Provision Type", { required: false, editable: false }),
    f("reserved", "Reserved PCUs", {
      kind: "number",
      required: false,
      description: "Committed capacity. Raising it raises the committed bill.",
    }),
    f("min", "Minimum PCUs", { kind: "number", required: false }),
    f("max", "Maximum PCUs", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
    f("datacenters", "Databases", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "cpu",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "unpark",
    stopActionId: "park",
    statusFieldKey: "status",
    runningValues: ["ACTIVE"],
    stoppedValues: ["PARKED", "PARKING"],
  },
  orphanRule: {
    conditions: [
      { fieldKey: "datacenters", when: "empty" },
      { fieldKey: "status", when: "equals", value: "ACTIVE" },
    ],
    reason:
      "Active PCU group with no database associated: its reserved capacity is billed for nothing.",
  },
});

const TenantType = rt({
  name: "Streaming Tenant",
  id: T.tenant,
  description: "An Astra Streaming (Apache Pulsar) tenant on a streaming cluster",
  fields: [
    f("tenantName", "Tenant", { editable: false }),
    f("clusterName", "Cluster", { editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("pulsarVersion", "Pulsar Version", { required: false, editable: false }),
    f("brokerServiceUrl", "Broker URL", { required: false, editable: false }),
    f("webServiceUrl", "Admin URL", { required: false, editable: false }),
    f("websocketUrl", "WebSocket URL", { required: false, editable: false }),
    f("userMetricsUrl", "Metrics URL", { required: false, editable: false }),
  ],
  outputs: [
    o("brokerServiceUrl", "Broker Service URL"),
    o("webServiceUrl", "Web Service URL"),
    o("websocketUrl", "WebSocket URL"),
  ],
  iconKey: "stream",
  supportsCreate: true,
  supportsDelete: true,
  secretExportTemplates: [
    {
      id: "pulsar-urls",
      displayName: "Pulsar URLs",
      description: "Broker and admin URLs for Pulsar clients",
      entries: [
        { envKey: "PULSAR_SERVICE_URL", outputKey: "brokerServiceUrl" },
        { envKey: "PULSAR_WEB_SERVICE_URL", outputKey: "webServiceUrl" },
      ],
    },
  ],
});

const RoleType = rt({
  name: "Role",
  id: T.role,
  description: "An organization role: a policy of permissions over resources",
  fields: [
    f("name", "Name"),
    f("roleId", "Role ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("resources", "Resources", { required: false, editable: false }),
    f("custom", "Custom", { kind: "boolean", required: false, editable: false }),
    f("updatedAt", "Last Updated", { required: false, editable: false }),
  ],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const UserType = rt({
  name: "User",
  id: T.user,
  description: "A member of the organization and the roles they hold",
  fields: [
    f("email", "Email", { editable: false }),
    f("userId", "User ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("roleIds", "Role IDs", { required: false, editable: false }),
    f("isAdmin", "Organization Administrator", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  dependsOn: [{ fieldKey: "roleIds", targetTypeId: T.role, label: "has role" }],
  iconKey: "user",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  principalRole: { role: "user", adminIndicatorKey: "isAdmin", revokeActionId: "revoke" },
});

const TokenType = rt({
  name: "Application Token",
  id: T.token,
  description: "An application token (client id and secret) and the roles it carries",
  fields: [
    f("clientId", "Client ID", { editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("roleIds", "Role IDs", { required: false, editable: false }),
    f("createdAt", "Generated", { required: false, editable: false }),
    f("isAdmin", "Organization Administrator", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("token", "Token", {
      sensitive: true,
      description: "AstraCS token; only available right after creation",
    }),
  ],
  dependsOn: [{ fieldKey: "roleIds", targetTypeId: T.role, label: "has role" }],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Token due for rotation" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "isAdmin",
    revokeActionId: "revoke",
  },
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  DatabaseType,
  RegionType,
  KeyspaceType,
  CollectionType,
  AccessEntryType,
  CdcType,
  PrivateEndpointType,
  SnapshotType,
  PcuGroupType,
  TenantType,
  RoleType,
  UserType,
  TokenType,
];

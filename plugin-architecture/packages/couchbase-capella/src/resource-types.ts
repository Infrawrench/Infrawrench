import type { PeerGuidanceAction, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { COMPUTE_IDS, PROJECT_ROLES } from "./catalog.js";

export const T = {
  project: "capella-project",
  cluster: "capella-cluster",
  appService: "capella-app-service",
  bucket: "capella-bucket",
  scope: "capella-scope",
  collection: "capella-collection",
  credential: "capella-db-credential",
  cidr: "capella-allowed-cidr",
  backup: "capella-backup",
  replication: "capella-replication",
  networkPeer: "capella-network-peer",
  privateEndpoint: "capella-private-endpoint",
  user: "capella-user",
  apiKey: "capella-api-key",
} as const;

export const resetPasswordAction: PeerGuidanceAction = {
  label: "Reset password",
  command: "reset-password",
  title: "Reset the credential's password",
  description:
    "Capella only shows a database credential's password when it is created. Set a new one (or leave blank to generate one) and Infrawrench keeps it for the connection string.",
  fields: [
    { key: "password", label: "New password (optional)", kind: "password", required: false },
  ],
  submitLabel: "Reset",
};

const audit = [
  f("createdAt", "Created", { required: false, editable: false }),
  f("createdBy", "Created By", { required: false, editable: false }),
];

const ProjectType = rt({
  name: "Project",
  id: T.project,
  description: "A Capella project: the clusters and App Services a team works on",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("projectId", "Project ID", { editable: false }),
    ...audit,
  ],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const ClusterType = rt({
  name: "Cluster",
  id: T.cluster,
  description: "An operational Capella cluster (Couchbase Server), including the free tier",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("cidr", "CIDR", { required: false, editable: false }),
    f("version", "Couchbase Server", { required: false, editable: false }),
    f("configurationType", "Configuration", { required: false, editable: false }),
    f("availability", "Availability", { required: false, editable: false }),
    f("supportPlan", "Support Plan", {
      kind: "enum",
      enumValues: ["basic", "developer pro", "enterprise"],
      required: false,
    }),
    f("supportTimezone", "Support Timezone", {
      kind: "enum",
      enumValues: ["ET", "GMT", "IST", "PT"],
      required: false,
    }),
    f("freeTier", "Free Tier", { kind: "boolean", required: false, editable: false }),
    f("nodes", "Data Nodes", {
      kind: "number",
      required: false,
      description: "Number of nodes in the first service group (the one running the data service).",
    }),
    f("compute", "Node Size", {
      kind: "enum",
      enumValues: COMPUTE_IDS,
      required: false,
      description:
        "vCPUs / RAM GB for the first service group's nodes. Changing it rebalances the cluster.",
    }),
    f("vcpus", "vCPUs per Node", { kind: "number", required: false, editable: false }),
    f("totalNodes", "Total Nodes", { kind: "number", required: false, editable: false }),
    f("serviceGroups", "Service Groups", { required: false, editable: false }),
    f("deletionProtection", "Deletion Protection", { kind: "boolean", required: false }),
    f("connectionString", "Connection String", { required: false, editable: false }),
    f("appServiceId", "App Service", { required: false, editable: false }),
    f("memoryUsedMb", "Memory Used (MB)", { kind: "number", required: false, editable: false }),
    f("memoryTotalMb", "Memory Total (MB)", { kind: "number", required: false, editable: false }),
    ...audit,
  ],
  outputs: [
    o("connectionString", "Connection String", { description: "couchbases:// endpoint for SDKs" }),
    o("certificate", "CA Certificate", {
      description: "Cluster CA certificate (PEM)",
      hidden: true,
    }),
  ],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: T.project, label: "in project" }],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "turn-on",
    stopActionId: "turn-off",
    statusFieldKey: "state",
    runningValues: ["healthy", "degraded"],
    stoppedValues: ["turnedOff", "turningOff"],
  },
  backupPolicy: { protectedBy: [T.backup] },
  carbon: {
    regionFieldKey: "region",
    grid: "auto",
    vcpus: { from: "field", fieldKey: "vcpus" },
    countFieldKey: "totalNodes",
  },
  postureChecks: [
    {
      id: "capella-cluster-no-deletion-protection",
      title: "Deletion protection off",
      severity: "low",
      category: "data-protection",
      conditions: [
        { fieldKey: "deletionProtection", when: "falsy" },
        { fieldKey: "freeTier", when: "falsy" },
      ],
      reason:
        "The cluster can be deleted in one call. Turn on deletion protection for clusters that hold data you need.",
    },
  ],
});

const AppServiceType = rt({
  name: "App Service",
  id: T.appService,
  description: "A Capella App Service (Sync Gateway) linked to a cluster",
  parentTypeId: T.cluster,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("appServiceId", "App Service ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("nodes", "Nodes", { kind: "number", required: false }),
    f("compute", "Node Size", {
      kind: "enum",
      enumValues: ["2/4", "4/8", "8/16", "16/32", "36/72"],
      required: false,
      description: "vCPUs / RAM GB per node.",
    }),
    f("vcpus", "vCPUs per Node", { kind: "number", required: false, editable: false }),
    ...audit,
  ],
  dependsOn: [
    {
      fieldKey: "clusterId",
      targetTypeId: T.cluster,
      matchTemplate: "{projectId}/{clusterId}",
      label: "syncs",
    },
  ],
  iconKey: "sync",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  lifecycle: {
    startActionId: "turn-on",
    stopActionId: "turn-off",
    statusFieldKey: "state",
    runningValues: ["healthy", "degraded"],
    stoppedValues: ["turnedOff", "turningOff"],
  },
});

const BucketType = rt({
  name: "Bucket",
  id: T.bucket,
  description: "A bucket on a cluster, with its memory quota, replicas and durability",
  parentTypeId: T.cluster,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("bucketId", "Bucket ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("storageBackend", "Storage Backend", { required: false, editable: false }),
    f("memoryAllocationInMb", "Memory Quota (MB)", { kind: "number", required: false }),
    f("replicas", "Replicas", { kind: "enum", enumValues: ["1", "2", "3"], required: false }),
    f("durabilityLevel", "Minimum Durability", {
      kind: "enum",
      enumValues: ["none", "majority", "majorityAndPersistActive", "persistToMajority"],
      required: false,
    }),
    f("timeToLiveInSeconds", "Max TTL (seconds)", {
      kind: "number",
      required: false,
      description: "0 means documents never expire.",
    }),
    f("flushEnabled", "Flush Enabled", { kind: "boolean", required: false }),
    f("evictionPolicy", "Eviction Policy", { required: false, editable: false }),
    f("conflictResolution", "Conflict Resolution", { required: false, editable: false }),
    f("itemCount", "Items", { kind: "number", required: false, editable: false }),
    f("opsPerSecond", "Ops/sec", { kind: "number", required: false, editable: false }),
    f("diskUsedMib", "Disk Used (MiB)", { kind: "number", required: false, editable: false }),
    f("memoryUsedMib", "Memory Used (MiB)", { kind: "number", required: false, editable: false }),
    f("backupSchedule", "Backup Schedule", { required: false, editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "clusterId",
      targetTypeId: T.cluster,
      matchTemplate: "{projectId}/{clusterId}",
      label: "on",
    },
  ],
  iconKey: "bucket",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  orphanRule: {
    conditions: [{ fieldKey: "itemCount", when: "equals", value: "0" }],
    reason: "The bucket holds no documents but still reserves its memory quota on the cluster.",
  },
});

const ScopeType = rt({
  name: "Scope",
  id: T.scope,
  description: "A scope inside a bucket",
  parentTypeId: T.bucket,
  fields: [
    f("name", "Name", { editable: false }),
    f("bucketName", "Bucket", { editable: false }),
    f("collections", "Collections", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "folder",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
});

const CollectionType = rt({
  name: "Collection",
  id: T.collection,
  description: "A collection inside a scope",
  parentTypeId: T.scope,
  fields: [
    f("name", "Name", { editable: false }),
    f("scope", "Scope", { editable: false }),
    f("bucketName", "Bucket", { editable: false }),
    f("maxTTL", "Max TTL (seconds)", {
      kind: "number",
      required: false,
      description: "0 inherits the bucket's; -1 never expires.",
    }),
  ],
  iconKey: "table",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const CredentialType = rt({
  name: "Database Credential",
  id: T.credential,
  description: "A database user the SDKs connect with, and the buckets it can read and write",
  parentTypeId: T.cluster,
  fields: [
    f("name", "Username", { editable: false }),
    f("credentialId", "Credential ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("access", "Access", { required: false, editable: false }),
    f("userRoles", "User Roles", { required: false, editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Set a new password. Leave blank to keep the current one.",
    }),
    ...audit,
  ],
  outputs: [
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "couchbases://user:password@host, for clients that take a single URI",
    }),
  ],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "access-key",
      label: "Credential due for rotation",
      maxAgeDays: 365,
    },
  ],
});

const CidrType = rt({
  name: "Allowed CIDR",
  id: T.cidr,
  description: "An address range allowed to connect to a cluster",
  parentTypeId: T.cluster,
  fields: [
    f("cidr", "CIDR", { editable: false }),
    f("comment", "Comment", { required: false, editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    ...audit,
  ],
  iconKey: "shield",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Allowed CIDR expires" },
  ],
  postureChecks: [
    {
      id: "capella-cidr-open-world",
      title: "Cluster open to every address",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "cidr", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "status", when: "equals", value: "active" },
      ],
      reason:
        "0.0.0.0/0 on the allowed list lets any address reach the cluster's endpoints; only the database credentials stand in the way.",
    },
  ],
});

const BackupType = rt({
  name: "Backup",
  id: T.backup,
  description: "A full or incremental bucket backup",
  parentTypeId: T.cluster,
  fields: [
    f("backupId", "Backup ID", { editable: false }),
    f("bucketName", "Bucket", { editable: false }),
    f("clusterKey", "Cluster", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("method", "Method", { required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("createdAt", "Taken", { required: false, editable: false }),
    f("restoreBefore", "Restorable Until", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("items", "Items", { kind: "number", required: false, editable: false }),
    f("elapsedSeconds", "Duration (s)", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "backup",
  pinnable: false,
  supportsDelete: true,
  backupRole: { role: "snapshot", sourceKey: "clusterKey", sizeKey: "sizeGb" },
});

const ReplicationType = rt({
  name: "XDCR Replication",
  id: T.replication,
  description: "Cross data center replication from this cluster to another",
  parentTypeId: T.cluster,
  fields: [
    f("replicationId", "Replication ID", { editable: false }),
    f("sourceCluster", "Source", { editable: false }),
    f("targetCluster", "Target", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("direction", "Direction", { required: false, editable: false }),
    ...audit,
  ],
  iconKey: "sync",
  pinnable: false,
  supportsDelete: true,
});

const NetworkPeerType = rt({
  name: "Network Peer",
  id: T.networkPeer,
  description: "A VPC or VNet peering between a cluster and your cloud network",
  parentTypeId: T.cluster,
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("reasoning", "Reason", { required: false, editable: false }),
    f("peerDetails", "Peer", { required: false, editable: false }),
    ...audit,
  ],
  iconKey: "network",
  pinnable: false,
  supportsDelete: true,
});

const PrivateEndpointType = rt({
  name: "Private Endpoint",
  id: T.privateEndpoint,
  description: "A private endpoint into a cluster's private endpoint service",
  parentTypeId: T.cluster,
  fields: [
    f("endpointId", "Endpoint ID", { editable: false }),
    f("serviceName", "Service", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("dns", "Private DNS", { required: false, editable: false }),
  ],
  iconKey: "network",
  pinnable: false,
  supportsDelete: false,
});

const UserType = rt({
  name: "User",
  id: T.user,
  description: "A member of the Capella organization with organization and project roles",
  fields: [
    f("email", "Email", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("userId", "User ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("inactive", "Inactive", { kind: "boolean", required: false, editable: false }),
    f("organizationRoles", "Organization Roles", { required: false, editable: false }),
    f("projectRoles", "Project Roles", { required: false, editable: false }),
    f("isOwner", "Organization Owner", { kind: "boolean", required: false, editable: false }),
    f("lastLogin", "Last Login", { required: false, editable: false }),
    ...audit,
  ],
  iconKey: "user",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  // No revokeActionId: Capella's only way to revoke a user is to delete them
  // from the organization, which the access review's Revoke must never do.
  principalRole: {
    role: "user",
    lastUsedKey: "lastLogin",
    adminIndicatorKey: "isOwner",
  },
  orphanRule: {
    conditions: [{ fieldKey: "inactive", when: "equals", value: "true" }],
    reason: "Capella marks this user inactive. Remove them if they no longer need access.",
  },
});

const ApiKeyType = rt({
  name: "API Key",
  id: T.apiKey,
  description: "A Management API key with organization and project roles",
  fields: [
    f("name", "Name", { editable: false }),
    f("keyId", "Key ID", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("organizationRoles", "Organization Roles", { required: false, editable: false }),
    f("projectRoles", "Project Roles", { required: false, editable: false }),
    f("allowedCidrs", "Allowed CIDRs", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("isOwner", "Organization Owner", { kind: "boolean", required: false, editable: false }),
    ...audit,
  ],
  outputs: [
    o("token", "Token", {
      sensitive: true,
      description: "Only available right after creation or rotation",
    }),
  ],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "isOwner",
    revokeActionId: "revoke",
  },
  postureChecks: [
    {
      id: "capella-api-key-any-address",
      title: "API key usable from any address",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "allowedCidrs", when: "equals", value: "0.0.0.0/0" }],
      reason:
        "The key's allowed CIDRs include 0.0.0.0/0, so a leaked key works from anywhere. Restrict it to the networks that call the API.",
    },
  ],
});

export const PROJECT_ROLE_VALUES = PROJECT_ROLES;

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ProjectType,
  ClusterType,
  AppServiceType,
  BucketType,
  ScopeType,
  CollectionType,
  CredentialType,
  CidrType,
  BackupType,
  ReplicationType,
  NetworkPeerType,
  PrivateEndpointType,
  UserType,
  ApiKeyType,
];

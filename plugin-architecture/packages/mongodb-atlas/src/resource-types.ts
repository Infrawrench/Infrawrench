import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { ATLAS_CLUSTER_EXTENDED_SUPPORT } from "./extended-support.js";
import { ALL_DEDICATED_TIERS } from "./tiers.js";

/**
 * MongoDB Atlas resource types. Field names follow the Admin API v2 schemas
 * (github.com/mongodb/openapi, 2026-10). Everything below the organization is
 * scoped to a project (`groupId` in the API), so project-level types are
 * children of `project` and cluster-level types children of the cluster they
 * belong to. The ones people go looking for directly (clusters, users, the
 * access list, open alerts) are surfaced in the sidebar too.
 *
 * External ids are paths: `{groupId}/{clusterName}`, `{groupId}/{db}/{user}`
 * and so on. Cluster names cannot contain a slash; usernames and access list
 * entries (CIDR blocks) can, so they always sit last.
 */

const PROJECT_PARENT = "project";
const CLUSTER_PARENT = "cluster";

const projectFields = [
  f("groupId", "Project ID", { required: false, editable: false }),
  f("projectName", "Project", { required: false, editable: false }),
];

const clusterRef = [
  ...projectFields,
  f("clusterName", "Cluster", { required: false, editable: false }),
];

/** Shown when the MongoDB console tab cannot connect because nothing is reachable. */
const MONGO_PEER_UNREACHABLE = {
  fieldsEmpty: ["standardSrv"],
  title: "This cluster has no public connection string.",
  suggestions: [
    "Clusters reachable only through private endpoints or peering cannot be browsed from here.",
    "Connect from a host inside that network, or add a public endpoint in Atlas.",
  ],
};

const connectionUserAction = {
  label: "+ Create connection user",
  command: "create-connection-user",
  title: "Create connection user",
  description:
    "Atlas never returns a database user's password, so Infrawrench creates a user scoped to this cluster with a generated password and keeps the password encrypted, so this tab can connect. The project's IP access list must allow Infrawrench to reach the cluster.",
  submitLabel: "Create user",
  fields: [
    {
      key: "role",
      label: "Access",
      kind: "select" as const,
      required: true,
      defaultValue: "readAnyDatabase",
      options: [
        { id: "readAnyDatabase", label: "Read only (readAnyDatabase)" },
        { id: "readWriteAnyDatabase", label: "Read and write (readWriteAnyDatabase)" },
      ],
    },
  ],
};

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Atlas organization this connection reads. Shows the pending invoice for the current month by service and project, recent invoices, and charts daily spend.",
  fields: [
    f("name", "Name", { editable: false }),
    f("orgId", "Organization ID", { required: false, editable: false }),
    f("pendingTotal", "Month-to-Date Charges (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectCount", "Projects", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("orgId", "Organization ID")],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "organization",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "An Atlas project: the unit clusters, database users, the IP access list, alerts and private endpoints belong to. Add an IP access list entry from here.",
  fields: [
    f("name", "Name"),
    f("groupId", "Project ID", { required: false, editable: false }),
    f("clusterCount", "Clusters", { kind: "number", required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Project ID")],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "project",
});

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "cluster",
  description:
    "A dedicated Atlas cluster. Pause and resume it, scale its tier and storage, toggle auto-scaling and termination protection, take an on-demand snapshot, chart connections, operations, CPU, disk IOPS and replication lag, and open its data in the MongoDB console.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("instanceSize", "Tier", {
      kind: "enum",
      required: false,
      enumValues: ALL_DEDICATED_TIERS,
      description:
        "The instance size of every electable node. Atlas applies the change as a rolling resize with no downtime. Not every tier is offered on every cloud or in every region.",
    }),
    f("diskSizeGB", "Storage (GB)", {
      kind: "number",
      required: false,
      description: "Storage per node. Atlas can grow storage but never shrinks it below the data.",
    }),
    f("autoScalingCompute", "Compute Auto-Scaling", {
      kind: "boolean",
      required: false,
      description: "Let Atlas move the tier up (and down) with load.",
    }),
    f("autoScalingDisk", "Storage Auto-Scaling", {
      kind: "boolean",
      required: false,
      description: "Let Atlas grow storage when the disk fills up.",
    }),
    f("terminationProtectionEnabled", "Termination Protection", {
      kind: "boolean",
      required: false,
      description: "Block deleting the cluster until this is turned off.",
    }),
    f("stateName", "State", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("clusterType", "Type", { required: false, editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("mongoDBVersion", "MongoDB Version", { required: false, editable: false }),
    f("nodeCount", "Electable Nodes", { kind: "number", required: false, editable: false }),
    f("shardCount", "Shards", { kind: "number", required: false, editable: false }),
    f("minInstanceSize", "Auto-Scaling Minimum", { required: false, editable: false }),
    f("maxInstanceSize", "Auto-Scaling Maximum", { required: false, editable: false }),
    f("backupEnabled", "Cloud Backup", { kind: "boolean", required: false, editable: false }),
    f("pitEnabled", "Continuous Backup", { kind: "boolean", required: false, editable: false }),
    f("standardSrv", "Connection String", { required: false, editable: false }),
    f("createDate", "Created", { required: false, editable: false }),
    f("clusterId", "Cluster ID", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [
    o("standardSrv", "Connection String (SRV)"),
    o("standard", "Connection String"),
    o("connectionString", "Connection String with Credentials", {
      sensitive: true,
      hidden: true,
      description:
        "The SRV connection string with the credentials of the connection user Infrawrench created for this cluster.",
    }),
  ],
  dependsOn: [{ fieldKey: "groupId", targetTypeId: "project", label: "in project" }],
  peerIntegrations: [
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      requiresFields: ["standardSrv"],
      unreachableWhen: MONGO_PEER_UNREACHABLE,
      credentialSetupAction: connectionUserAction,
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "MONGODB_URI with the connection user's credentials",
      entries: [{ envKey: "MONGODB_URI", outputKey: "connectionString" }],
    },
  ],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "paused",
    runningValues: ["false"],
    stoppedValues: ["true"],
  },
  rightsizing: {
    sizeFieldKey: "instanceSize",
    regionFieldKey: "region",
    diskFieldKey: "diskSizeGB",
    cpuMetric: { seriesLabel: "CPU (normalized, max across nodes)", scale: "percent" },
    memoryMetric: { seriesLabel: "Memory used (max across nodes)", interpretation: "used-bytes" },
    // Keep general (M), low-CPU (R) and NVMe tiers apart: Atlas moves a
    // cluster between classes only through a different workflow.
    sizeFamilyPattern: "^([A-Z])\\d+(_NVME)?",
    resizeNote:
      "Atlas resizes one node at a time with no downtime. Savings are per node, at the hourly rates on this organization's recent invoices; tiers the organization has not been billed for have no rate and are not suggested.",
  },
  carbon: {
    regionFieldKey: "cloudRegion",
    grid: "auto",
    vcpus: { from: "field", fieldKey: "vcpus" },
    countFieldKey: "nodeCount",
  },
  backupPolicy: {
    protectedBy: ["backup-snapshot"],
    automatedBackupFieldKey: "backupEnabled",
    automatedBackupWhen: "truthy",
  },
  orphanRule: {
    conditions: [{ fieldKey: "paused", when: "equals", value: "true" }],
    reason:
      "Paused: compute is not billed, but storage and backups still are, and Atlas resumes a cluster automatically after 30 days.",
  },
  postureChecks: [
    {
      id: "atlas-cluster-no-backup",
      title: "Cluster has cloud backup turned off",
      severity: "high",
      category: "data-protection",
      conditions: [{ fieldKey: "backupEnabled", when: "falsy" }],
      reason: "No snapshots are taken, so the data cannot be restored after a mistake.",
    },
    {
      id: "atlas-cluster-no-termination-protection",
      title: "Cluster can be deleted without a safeguard",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "terminationProtectionEnabled", when: "falsy" }],
      reason: "Termination protection is off, so one API call or click deletes the cluster.",
    },
  ],
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  extendedSupport: ATLAS_CLUSTER_EXTENDED_SUPPORT,
  iconKey: "mongodb",
});

export const FlexClusterResourceType = rt({
  name: "Flex Cluster",
  id: "flex-cluster",
  description:
    "An Atlas Flex cluster: shared hardware billed by usage up to a monthly cap. Toggle termination protection and open its data in the MongoDB console.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("terminationProtectionEnabled", "Termination Protection", {
      kind: "boolean",
      required: false,
    }),
    f("stateName", "State", { required: false, editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("mongoDBVersion", "MongoDB Version", { required: false, editable: false }),
    f("diskSizeGB", "Storage (GB)", { kind: "number", required: false, editable: false }),
    f("backupEnabled", "Backup", { kind: "boolean", required: false, editable: false }),
    f("standardSrv", "Connection String", { required: false, editable: false }),
    f("createDate", "Created", { required: false, editable: false }),
    f("clusterId", "Cluster ID", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [
    o("standardSrv", "Connection String (SRV)"),
    o("connectionString", "Connection String with Credentials", { sensitive: true, hidden: true }),
  ],
  dependsOn: [{ fieldKey: "groupId", targetTypeId: "project", label: "in project" }],
  peerIntegrations: [
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      requiresFields: ["standardSrv"],
      unreachableWhen: MONGO_PEER_UNREACHABLE,
      credentialSetupAction: connectionUserAction,
    },
  ],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "database",
});

export const ServerlessInstanceResourceType = rt({
  name: "Serverless Instance",
  id: "serverless-instance",
  description:
    "A legacy Atlas serverless instance. MongoDB is migrating these to Flex clusters; listed so their spend and connection strings stay visible.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("stateName", "State", { required: false, editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("mongoDBVersion", "MongoDB Version", { required: false, editable: false }),
    f("terminationProtectionEnabled", "Termination Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("standardSrv", "Connection String", { required: false, editable: false }),
    f("createDate", "Created", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [o("standardSrv", "Connection String (SRV)")],
  supportsDelete: false,
  iconKey: "database",
});

export const DatabaseUserResourceType = rt({
  name: "Database User",
  id: "database-user",
  description:
    "A database user in an Atlas project. Create one with a role, change its roles or description, or delete it.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("username", "Username", { editable: false }),
    f("roles", "Roles", {
      required: false,
      description:
        "Comma-separated role@database pairs, e.g. readWrite@app, read@reporting. Built-in roles: atlasAdmin, readWriteAnyDatabase and readAnyDatabase (on admin), readWrite, read, dbAdmin.",
    }),
    f("description", "Description", { required: false }),
    f("databaseName", "Auth Database", { required: false, editable: false }),
    f("authType", "Authentication", { required: false, editable: false }),
    f("scopes", "Limited To", { required: false, editable: false }),
    f("deleteAfterDate", "Expires", { required: false, editable: false }),
    f("hasAtlasAdmin", "Atlas Admin", { kind: "boolean", required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [o("username", "Username")],
  dependsOn: [{ fieldKey: "groupId", targetTypeId: "project", label: "in project" }],
  expiryFields: [
    {
      fieldKey: "deleteAfterDate",
      from: "expiry",
      kind: "access-key",
      label: "Temporary user expires",
    },
  ],
  postureChecks: [
    {
      id: "atlas-user-atlas-admin",
      title: "Database user has atlasAdmin",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "hasAtlasAdmin", when: "truthy" }],
      reason: "atlasAdmin can read, write and drop every database in every cluster of the project.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const IpAccessEntryResourceType = rt({
  name: "IP Access List Entry",
  plural: "IP Access List",
  id: "ip-access-entry",
  description:
    "An address, CIDR block or AWS security group allowed to connect to the project's clusters. Add one, change its comment, or remove it.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("entry", "Entry", { editable: false }),
    f("comment", "Comment", { required: false }),
    f("kind", "Kind", { required: false, editable: false }),
    f("deleteAfterDate", "Expires", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [o("entry", "Entry")],
  dependsOn: [{ fieldKey: "groupId", targetTypeId: "project", label: "in project" }],
  expiryFields: [
    {
      fieldKey: "deleteAfterDate",
      from: "expiry",
      kind: "other",
      label: "Temporary access expires",
    },
  ],
  postureChecks: [
    {
      id: "atlas-access-anywhere",
      title: "Project allows connections from anywhere",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "entry", when: "equals", value: "0.0.0.0/0" }],
      reason:
        "0.0.0.0/0 lets any address on the internet attempt to connect; only database credentials stand in the way.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "ip",
});

export const BackupSnapshotResourceType = rt({
  name: "Backup Snapshot",
  id: "backup-snapshot",
  description:
    "A cloud backup snapshot of a dedicated cluster. Take an on-demand snapshot with its own retention, or delete one.",
  parentTypeId: CLUSTER_PARENT,
  fields: [
    f("description", "Description", { required: false, editable: false }),
    f("snapshotType", "Type", { required: false, editable: false }),
    f("frequencyType", "Frequency", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("createdAt", "Taken", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("storageSizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("mongodVersion", "MongoDB Version", { required: false, editable: false }),
    f("snapshotId", "Snapshot ID", { required: false, editable: false }),
    ...clusterRef,
  ],
  outputs: [o("snapshotId", "Snapshot ID")],
  backupRole: {
    role: "snapshot",
    sourceTemplate: "{groupId}/{clusterName}",
    createdKey: "createdAt",
    sizeKey: "storageSizeBytes",
    sizeUnit: "bytes",
  },
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "snapshot",
});

export const BackupPolicyResourceType = rt({
  name: "Backup Policy",
  plural: "Backup Policies",
  id: "backup-policy",
  description:
    "A cluster's cloud backup schedule: when snapshots are taken, how long each frequency is kept, and the continuous-restore window. Change the snapshot time and the restore window.",
  parentTypeId: CLUSTER_PARENT,
  fields: [
    f("referenceHourOfDay", "Snapshot Hour (UTC)", {
      kind: "number",
      required: false,
      description: "Hour of the day, 0 to 23 in UTC, at which the daily snapshot is taken.",
    }),
    f("referenceMinuteOfHour", "Snapshot Minute", {
      kind: "number",
      required: false,
      description: "Minute of that hour, 0 to 59.",
    }),
    f("restoreWindowDays", "Restore Window (days)", {
      kind: "number",
      required: false,
      description: "How far back continuous cloud backup can restore to, in days.",
    }),
    f("policySummary", "Retention", { required: false, editable: false }),
    f("nextSnapshot", "Next Snapshot", { required: false, editable: false }),
    f("autoExportEnabled", "Auto Export", { kind: "boolean", required: false, editable: false }),
    f("copyRegions", "Copies To", { required: false, editable: false }),
    ...clusterRef,
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: false,
  pinnable: false,
  iconKey: "policy",
});

export const AlertResourceType = rt({
  name: "Alert",
  id: "alert",
  description:
    "An open or recent Atlas alert in a project. Acknowledge it for a while, or clear the acknowledgement.",
  parentTypeId: PROJECT_PARENT,
  showInSidebar: true,
  fields: [
    f("eventTypeName", "Event", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("severity", "Severity", { required: false, editable: false }),
    f("metricName", "Metric", { required: false, editable: false }),
    f("currentValue", "Current Value", { required: false, editable: false }),
    f("hostnameAndPort", "Host", { required: false, editable: false }),
    f("replicaSetName", "Replica Set", { required: false, editable: false }),
    f("created", "Opened", { required: false, editable: false }),
    f("resolved", "Resolved", { required: false, editable: false }),
    f("acknowledgedUntil", "Acknowledged Until", { required: false, editable: false }),
    f("acknowledgingUsername", "Acknowledged By", { required: false, editable: false }),
    f("alertConfigId", "Alert Configuration ID", { required: false, editable: false }),
    ...clusterRef,
  ],
  outputs: [],
  dependsOn: [
    {
      fieldKey: "alertConfigId",
      matchTemplate: "{groupId}/{alertConfigId}",
      targetTypeId: "alert-configuration",
      label: "raised by",
    },
  ],
  supportsDelete: false,
  pinnable: false,
  iconKey: "bell",
});

export const AlertConfigurationResourceType = rt({
  name: "Alert Configuration",
  id: "alert-configuration",
  description:
    "A rule that raises Atlas alerts in a project: the event or metric threshold it watches and who it notifies. Enable, disable or delete it.",
  parentTypeId: PROJECT_PARENT,
  fields: [
    f("eventTypeName", "Event", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("threshold", "Threshold", { required: false, editable: false }),
    f("matchers", "Applies To", { required: false, editable: false }),
    f("notifications", "Notifies", { required: false, editable: false }),
    f("updated", "Updated", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [],
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

export const SearchIndexResourceType = rt({
  name: "Search Index",
  plural: "Search Indexes",
  id: "search-index",
  description:
    "An Atlas Search or Vector Search index on a cluster collection, with its build status. Delete it from here.",
  parentTypeId: CLUSTER_PARENT,
  fields: [
    f("name", "Name", { editable: false }),
    f("indexType", "Type", { required: false, editable: false }),
    f("database", "Database", { required: false, editable: false }),
    f("collectionName", "Collection", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("queryable", "Queryable", { kind: "boolean", required: false, editable: false }),
    f("indexId", "Index ID", { required: false, editable: false }),
    ...clusterRef,
  ],
  outputs: [o("indexId", "Index ID")],
  supportsDelete: true,
  pinnable: false,
  iconKey: "search",
});

export const OnlineArchiveResourceType = rt({
  name: "Online Archive",
  plural: "Online Archives",
  id: "online-archive",
  description:
    "An online archive moving aged documents from a cluster collection into cheaper object storage. Pause, resume or delete it.",
  parentTypeId: CLUSTER_PARENT,
  fields: [
    f("namespace", "Collection", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("criteria", "Archives", { required: false, editable: false }),
    f("expireAfterDays", "Deletes After (days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("schedule", "Schedule", { required: false, editable: false }),
    f("archiveId", "Archive ID", { required: false, editable: false }),
    ...clusterRef,
  ],
  outputs: [],
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "ORPHANED" }],
    reason:
      "Orphaned: its source collection is gone, so it archives nothing new but its stored data is still billed.",
  },
  supportsDelete: true,
  pinnable: false,
  iconKey: "archive",
});

export const PrivateEndpointServiceResourceType = rt({
  name: "Private Endpoint Service",
  id: "private-endpoint-service",
  description:
    "An Atlas private endpoint service (AWS PrivateLink, Azure Private Link or Google Private Service Connect) in a project, with the endpoints attached to it.",
  parentTypeId: PROJECT_PARENT,
  fields: [
    f("cloudProvider", "Cloud", { editable: false }),
    f("regionName", "Region", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("serviceName", "Service Name", { required: false, editable: false }),
    f("endpoints", "Endpoints", { required: false, editable: false }),
    f("endpointCount", "Endpoint Count", { kind: "number", required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
    ...projectFields,
  ],
  outputs: [o("serviceName", "Service Name")],
  orphanRule: {
    conditions: [{ fieldKey: "endpointCount", when: "equals", value: "0" }],
    reason: "No endpoint is connected to this private endpoint service.",
  },
  supportsDelete: true,
  pinnable: false,
  iconKey: "network",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  ClusterResourceType,
  FlexClusterResourceType,
  ServerlessInstanceResourceType,
  DatabaseUserResourceType,
  IpAccessEntryResourceType,
  BackupSnapshotResourceType,
  BackupPolicyResourceType,
  AlertResourceType,
  AlertConfigurationResourceType,
  SearchIndexResourceType,
  OnlineArchiveResourceType,
  PrivateEndpointServiceResourceType,
];

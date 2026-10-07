import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * External ids: the Qdrant Cloud UUID for clusters, database API keys,
 * backups, schedules, restores and hybrid environments; collections are
 * `<clusterId>/<collection name>` (collection names are only unique per
 * cluster).
 */

export const CLUSTER_PHASES = [
  "HEALTHY",
  "CREATING",
  "FAILED_TO_CREATE",
  "UPDATING",
  "FAILED_TO_UPDATE",
  "SCALING",
  "UPGRADING",
  "SUSPENDING",
  "SUSPENDED",
  "FAILED_TO_SUSPEND",
  "RESUMING",
  "FAILED_TO_RESUME",
  "NOT_READY",
  "RECOVERY_MODE",
  "MANUAL_MAINTENANCE",
  "FAILED_TO_SYNC",
  "NOT_FOUND",
  "DELETING",
  "UNKNOWN",
];

export const STORAGE_TIERS = ["COST_OPTIMISED", "BALANCED", "PERFORMANCE"];
export const RESTART_POLICIES = ["AUTOMATIC", "ROLLING", "PARALLEL"];
export const REBALANCE_STRATEGIES = ["BY_COUNT_AND_SIZE", "BY_COUNT", "BY_SIZE", "DISABLED"];

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "cluster",
  description: "A Qdrant database cluster in Qdrant Cloud (managed or hybrid)",
  fields: [
    f("name", "Name", {
      editable: false,
      description: "Letters, digits, underscores and hyphens, 2 to 64 characters",
    }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("cloudProvider", "Cloud", { editable: false }),
    f("region", "Region", { editable: false }),
    f("status", "Status", { kind: "enum", enumValues: CLUSTER_PHASES, editable: false }),
    f("statusReason", "Status Reason", { required: false, editable: false }),
    f("version", "Qdrant Version", {
      required: false,
      description: "Upgrade by entering a newer release; the detail page lists the available ones",
    }),
    f("nodes", "Nodes", {
      kind: "number",
      description:
        "Scaling out adds nodes; scaling in is refused by Qdrant when data would not fit",
    }),
    f("nodesUp", "Nodes Up", { kind: "number", required: false, editable: false }),
    f("packageId", "Package", {
      required: false,
      editable: false,
      description: "Resource package per node. Change it with Resize.",
    }),
    f("cpuPerNode", "vCPU per Node", { kind: "number", required: false, editable: false }),
    f("ramGibPerNode", "RAM per Node (GiB)", { kind: "number", required: false, editable: false }),
    f("diskGibPerNode", "Disk per Node (GiB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("additionalDiskGib", "Extra Disk (GiB)", {
      kind: "number",
      required: false,
      description: "Disk added on top of the package, per node. Disks can grow, not shrink.",
    }),
    f("storageTier", "Storage Tier", {
      kind: "enum",
      enumValues: STORAGE_TIERS,
      required: false,
      description: "Disk IOPS and throughput tier; BALANCED and PERFORMANCE cost extra",
    }),
    f("allowedIpSourceRanges", "Allowed IP Ranges", {
      required: false,
      description:
        "Comma-separated IPv4 CIDRs allowed to reach the database, at most 40. Empty allows all.",
    }),
    f("labels", "Labels", {
      required: false,
      description: "Comma-separated key=value pairs, shown in billing reports",
    }),
    f("replicationFactor", "Default Replication Factor", { kind: "number", required: false }),
    f("writeConsistencyFactor", "Default Write Consistency", { kind: "number", required: false }),
    f("vectorsOnDisk", "Vectors on Disk by Default", { kind: "boolean", required: false }),
    f("inferenceEnabled", "Cloud Inference", { kind: "boolean", required: false }),
    f("auditLogging", "Audit Logging", { kind: "boolean", required: false }),
    f("restartPolicy", "Restart Policy", {
      kind: "enum",
      enumValues: RESTART_POLICIES,
      required: false,
    }),
    f("rebalanceStrategy", "Shard Rebalancing", {
      kind: "enum",
      enumValues: REBALANCE_STRATEGIES,
      required: false,
    }),
    f("jwtRbac", "JWT RBAC", { kind: "boolean", required: false, editable: false }),
    f("url", "Endpoint", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("restartedAt", "Last Restart", { required: false, editable: false }),
  ],
  outputs: [
    o("url", "REST URL", { description: "Database REST endpoint, port 6333" }),
    o("grpcUrl", "gRPC URL", { description: "Database gRPC endpoint, port 6334" }),
    o("host", "Host"),
    o("clusterId", "Cluster ID"),
    o("apiKey", "Database API Key", {
      sensitive: true,
      description: "The key Infrawrench minted with Connect Infrawrench; Qdrant shows a key once",
    }),
  ],
  secretExportTemplates: [
    {
      id: "qdrant-env",
      displayName: "Qdrant environment variables",
      description: "QDRANT_URL and QDRANT_API_KEY",
      entries: [
        { envKey: "QDRANT_URL", outputKey: "url" },
        { envKey: "QDRANT_API_KEY", outputKey: "apiKey" },
      ],
    },
  ],
  dependsOn: [
    { fieldKey: "region", targetTypeId: "hybrid-environment", targetKey: "environmentId" },
  ],
  backupPolicy: { protectedBy: ["backup"] },
  lifecycle: {
    startActionId: "unsuspend",
    stopActionId: "suspend",
    statusFieldKey: "status",
    runningValues: ["HEALTHY"],
    stoppedValues: ["SUSPENDED"],
  },
  postureChecks: [
    {
      id: "qdrant-cluster-open-to-all-ips",
      title: "Database reachable from any IP",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "allowedIpSourceRanges", when: "empty" }],
      reason:
        "No allowed IP ranges are set, so the database endpoint accepts connections from the whole internet; only the API key protects it.",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const DatabaseApiKeyResourceType = rt({
  name: "Database API Key",
  id: "database-api-key",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "An API key for one cluster's database, with global or per-collection access",
  fields: [
    f("name", "Name", { editable: false }),
    f("keyId", "Key ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("access", "Access", { required: false, editable: false }),
    f("postfix", "Ends With", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdByEmail", "Creator Email", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("apiKey", "API Key", {
      sensitive: true,
      description: "Only for keys created from Infrawrench; Qdrant shows a key once",
    }),
  ],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "cluster" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  principalRole: {
    role: "key",
    adminIndicatorKey: "access",
    adminValues: ["Manage (global)"],
    parentKey: "clusterName",
  },
  iconKey: "key",
  supportsCreate: true,
});

export const BackupResourceType = rt({
  name: "Backup",
  id: "backup",
  description: "A backup of a Qdrant Cloud cluster",
  fields: [
    f("name", "Name", { required: false, description: "Display name; can be changed" }),
    f("backupId", "Backup ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "SUCCEEDED",
        "RUNNING",
        "SKIPPED",
        "FAILED",
        "FAILED_TO_SYNC",
        "NOT_FOUND",
        "UNKNOWN",
      ],
      editable: false,
    }),
    f("scheduleId", "Schedule ID", { required: false, editable: false }),
    f("cloudProvider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("retentionDays", "Retention (days)", { kind: "number", required: false, editable: false }),
    f("sizeGb", "Cluster Disk (GiB)", { kind: "number", required: false, editable: false }),
    f("monthlyCost", "Storage Cost per Month", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("currency", "Currency", { required: false, editable: false }),
    f("duration", "Duration", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "clusterId", targetTypeId: "cluster", label: "backup of" },
    { fieldKey: "scheduleId", targetTypeId: "backup-schedule", label: "taken by" },
  ],
  backupRole: {
    role: "snapshot",
    sourceKey: "clusterId",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
  iconKey: "backup",
  supportsCreate: true,
  supportsUpdate: true,
});

export const BackupScheduleResourceType = rt({
  name: "Backup Schedule",
  id: "backup-schedule",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "Automatic backups of a cluster on a cron schedule",
  fields: [
    f("name", "Name", { required: false, description: "Stamped onto every backup it takes" }),
    f("scheduleId", "Schedule ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("schedule", "Schedule (cron, UTC)", {
      description: "Standard 5-field crontab, e.g. 0 2 * * * for daily at 02:00",
    }),
    f("retentionDays", "Retention (days)", {
      kind: "number",
      description: "How long each backup is kept, 1 to 365 days",
    }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["ACTIVE", "DISABLED", "FAILED_TO_SYNC", "NOT_FOUND"],
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "cluster", label: "backs up" }],
  iconKey: "schedule",
  supportsCreate: true,
  supportsUpdate: true,
});

export const BackupRestoreResourceType = rt({
  name: "Backup Restore",
  id: "backup-restore",
  description: "A restore of a backup into a cluster",
  fields: [
    f("restoreId", "Restore ID", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("backupId", "Backup ID", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "FAILED_TO_SYNC", "NOT_FOUND"],
      editable: false,
    }),
    f("createdAt", "Started", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "backupId", targetTypeId: "backup", label: "restores" },
    { fieldKey: "clusterId", targetTypeId: "cluster", label: "into" },
  ],
  iconKey: "restore",
  pinnable: false,
  supportsDelete: false,
});

export const HybridEnvironmentResourceType = rt({
  name: "Hybrid Cloud Environment",
  id: "hybrid-environment",
  description: "Your own Kubernetes cluster registered with Qdrant Hybrid Cloud",
  fields: [
    f("name", "Name"),
    f("environmentId", "Environment ID", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["READY", "NOT_READY", "FAILED_TO_SYNC", "PENDING"],
      editable: false,
    }),
    f("namespace", "Namespace", { required: false, editable: false }),
    f("kubernetesVersion", "Kubernetes Version", { required: false, editable: false }),
    f("kubernetesDistribution", "Distribution", { required: false, editable: false }),
    f("kubernetesNodes", "Kubernetes Nodes", { kind: "number", required: false, editable: false }),
    f("readyForClusters", "Ready for Clusters", { required: false, editable: false }),
    f("bootstrapped", "Bootstrap Commands Generated", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("statusMessage", "Status Message", { required: false, editable: false }),
    f("createdByEmail", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("environmentId", "Environment ID"),
    o("bootstrapCommands", "Bootstrap Commands", {
      sensitive: true,
      description:
        "kubectl and helm commands from Generate bootstrap commands; they embed an access key",
    }),
  ],
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsUpdate: true,
});

export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  parentTypeId: "cluster",
  showInSidebar: true,
  description: "A collection inside a cluster, read through the cluster's own REST API",
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["green", "yellow", "grey", "red"],
      required: false,
      editable: false,
    }),
    f("pointsCount", "Points", { kind: "number", required: false, editable: false }),
    f("indexedVectorsCount", "Indexed Vectors", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("segmentsCount", "Segments", { kind: "number", required: false, editable: false }),
    f("vectorSize", "Vector Size", { kind: "number", required: false, editable: false }),
    f("distance", "Distance", { required: false, editable: false }),
    f("namedVectors", "Named Vectors", { required: false, editable: false }),
    f("shardNumber", "Shards", { kind: "number", required: false, editable: false }),
    f("replicationFactor", "Replication Factor", {
      kind: "number",
      required: false,
      description: "Replicas of each shard. Raising it needs at least that many nodes.",
    }),
    f("writeConsistencyFactor", "Write Consistency", {
      kind: "number",
      required: false,
      description: "Replicas that must acknowledge a write, at most the replication factor",
    }),
  ],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "cluster" }],
  iconKey: "collection",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  DatabaseApiKeyResourceType,
  BackupResourceType,
  BackupScheduleResourceType,
  BackupRestoreResourceType,
  HybridEnvironmentResourceType,
  CollectionResourceType,
];

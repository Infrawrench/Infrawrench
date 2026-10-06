import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const ROLES = [
  "ORG_ADMIN",
  "ORG_MEMBER",
  "BILLING_COORDINATOR",
  "BILLING_VIEWER",
  "CLUSTER_ADMIN",
  "CLUSTER_OPERATOR_WRITER",
  "CLUSTER_DEVELOPER",
  "CLUSTER_CREATOR",
  "CLUSTER_MONITOR",
  "CLUSTER_DATA_ACCESSOR",
  "FOLDER_ADMIN",
  "FOLDER_MOVER",
  "METRICS_VIEWER",
  "AUDITOR",
];

export const BACKUP_FREQUENCIES = ["5", "10", "15", "30", "60", "240", "1440"];
export const BACKUP_RETENTIONS = ["2", "7", "30", "90", "365"];
export const DEFERRAL_POLICIES = [
  "NOT_DEFERRED",
  "DEFERRAL_30_DAYS",
  "DEFERRAL_60_DAYS",
  "DEFERRAL_90_DAYS",
  "FIXED_DEFERRAL",
];

const ro = { required: false, editable: false } as const;
const dependsOnCluster = [
  { fieldKey: "clusterId", targetTypeId: "crdb-cluster", label: "on cluster" },
];

export const OrganizationType = rt({
  name: "Organization",
  id: "crdb-organization",
  description: "The CockroachDB Cloud organization the API key belongs to",
  fields: [
    f("name", "Name", { editable: false }),
    f("label", "Label", ro),
    f("organizationId", "Organization ID", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("organizationId", "Organization ID")],
  supportsDelete: false,
  iconKey: "cockroach",
});

export const FolderType = rt({
  name: "Folder",
  id: "crdb-folder",
  description: "A folder that groups clusters (and other folders) for access control",
  fields: [
    f("name", "Name"),
    f("parentId", "Parent Folder", { ...ro, description: "root for the top level." }),
    f("path", "Path", ro),
  ],
  outputs: [o("folderId", "Folder ID")],
  dependsOn: [{ fieldKey: "parentId", targetTypeId: "crdb-folder", label: "inside" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const ClusterType = rt({
  name: "Cluster",
  id: "crdb-cluster",
  description: "A CockroachDB Cloud cluster (Basic, Standard or Advanced)",
  fields: [
    f("name", "Name", { editable: false }),
    f("plan", "Plan", ro),
    f("cloudProvider", "Cloud", ro),
    f("region", "Primary Region", ro),
    f("regions", "Regions", ro),
    f("version", "CockroachDB Version", ro),
    f("state", "State", ro),
    f("operationStatus", "Operation", ro),
    f("upgradeStatus", "Upgrade Status", ro),
    f("sqlDns", "SQL Host", ro),
    f("networkVisibility", "Network Visibility", ro),
    f("egressPolicy", "Egress Traffic Policy", ro),
    f("folderId", "Folder", ro),
    f("deleteProtection", "Delete Protection", { kind: "boolean", required: false }),
    f("nodeCount", "Nodes", {
      kind: "number",
      required: false,
      description: "Advanced: nodes per region (minimum 3 for production).",
    }),
    f("vcpus", "vCPUs per Node", {
      kind: "number",
      required: false,
      description: "Advanced: the machine is chosen from this. Scaling rolls the nodes.",
    }),
    f("machineType", "Machine Type", ro),
    f("memoryGib", "Memory per Node (GiB)", { kind: "number", ...ro }),
    f("storageGib", "Storage per Node (GiB)", {
      kind: "number",
      required: false,
      description: "Advanced: storage can grow but not shrink.",
    }),
    f("diskIops", "Disk IOPS", {
      kind: "number",
      required: false,
      description: "Advanced on AWS only.",
    }),
    f("provisionedVcpus", "Provisioned vCPUs", {
      kind: "number",
      required: false,
      description: "Standard: the vCPUs reserved for the cluster.",
    }),
    f("requestUnitLimit", "Monthly Request Unit Limit", {
      kind: "number",
      required: false,
      description: "Basic: the cluster is disabled once the month's request units are used up.",
    }),
    f("storageMibLimit", "Storage Limit (MiB)", {
      kind: "number",
      required: false,
      description: "Basic.",
    }),
    f("upgradeType", "Version Upgrades", {
      kind: "enum",
      enumValues: ["AUTOMATIC", "MANUAL"],
      required: false,
      description: "Basic/Standard: whether major upgrades are applied automatically.",
    }),
    f("backupsEnabled", "Managed Backups", { kind: "boolean", required: false }),
    f("backupFrequencyMinutes", "Backup Every (minutes)", {
      kind: "enum",
      enumValues: BACKUP_FREQUENCIES,
      required: false,
    }),
    f("backupRetentionDays", "Backup Retention (days)", {
      kind: "enum",
      enumValues: BACKUP_RETENTIONS,
      required: false,
      description: "Can only be set once; later changes need a support ticket.",
    }),
    f("deferralPolicy", "Patch Upgrade Deferral", {
      kind: "enum",
      enumValues: DEFERRAL_POLICIES,
      required: false,
    }),
    f("maintenanceOffsetHours", "Maintenance Window Start (hours after Monday 00:00 UTC)", {
      kind: "number",
      required: false,
      description: "Advanced only.",
    }),
    f("maintenanceDurationHours", "Maintenance Window Length (hours)", {
      kind: "number",
      required: false,
      description: "At least 6 hours.",
    }),
    f("cmekStatus", "CMEK", ro),
    f("allowlistOpen", "Allowlist Open to the Internet", { kind: "boolean", ...ro }),
    f("createdAt", "Created At", ro),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("sqlHost", "SQL Host"),
    o("connectionStringTemplate", "Connection String (no credentials)"),
  ],
  dependsOn: [{ fieldKey: "folderId", targetTypeId: "crdb-folder", label: "in folder" }],
  postureChecks: [
    {
      id: "crdb-cluster-allowlist-open",
      title: "Cluster accepts SQL connections from any address",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "allowlistOpen", when: "truthy" }],
      reason:
        "The IP allowlist has a 0.0.0.0/0 entry with SQL access, so the cluster's SQL port is reachable from the whole internet and only SQL passwords protect it.",
    },
    {
      id: "crdb-cluster-delete-protection-off",
      title: "Delete protection is off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "deleteProtection", when: "falsy" }],
      reason: "Turn on delete protection so the cluster and its data cannot be deleted by mistake.",
    },
    {
      id: "crdb-cluster-backups-off",
      title: "Managed backups are disabled",
      severity: "high",
      category: "data-protection",
      conditions: [{ fieldKey: "backupsEnabled", when: "falsy" }],
      reason:
        "CockroachDB Cloud is not taking managed backups of this cluster, so nothing can be restored after data loss.",
    },
  ],
  backupPolicy: { protectedBy: ["crdb-backup"], automatedBackupFieldKey: "backupsEnabled" },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const DatabaseType = rt({
  name: "Database",
  id: "crdb-database",
  description: "A database on a cluster",
  fields: [
    f("name", "Name", { description: "Renaming a database breaks clients that name it." }),
    f("clusterId", "Cluster", { editable: false }),
    f("tableCount", "Tables", { kind: "number", ...ro }),
  ],
  outputs: [o("databaseName", "Database Name")],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const SqlUserType = rt({
  name: "SQL User",
  id: "crdb-sql-user",
  description:
    "A SQL user on a cluster. Its password is stored encrypted when set from Infrawrench.",
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Write-only. Set a new password; leave blank to keep the current one.",
    }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("username", "Username"),
  ],
  dependsOn: dependsOnCluster,
  principalRole: { role: "user" },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "SQL",
      credentialSetupAction: {
        label: "Set a password",
        command: "reset-password",
        title: "Set this SQL user's password",
        description:
          "CockroachDB Cloud never returns SQL passwords. Set one so Infrawrench can connect; clients using the old password stop working.",
        submitLabel: "Set password",
        fields: [
          {
            key: "password",
            label: "New password",
            kind: "password",
            required: false,
            description: "Leave blank to generate a strong random password.",
          },
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "database-url",
      displayName: "Database URL",
      description: "DATABASE_URL for this SQL user",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const AllowlistEntryType = rt({
  name: "Allowlist Entry",
  plural: "IP Allowlist",
  pinnable: false,
  id: "crdb-allowlist-entry",
  description: "A CIDR range allowed to reach the cluster's SQL port and/or DB Console",
  fields: [
    f("cidr", "CIDR", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("name", "Name", { required: false }),
    f("sql", "SQL Access", { kind: "boolean", required: false }),
    f("ui", "DB Console Access", { kind: "boolean", required: false }),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  postureChecks: [
    {
      id: "crdb-allowlist-world-sql",
      title: "Allowlist entry opens SQL to the internet",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "cidr", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "sql", when: "truthy" },
      ],
      reason: "This entry lets any address reach the cluster's SQL port.",
    },
  ],
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const BackupType = rt({
  name: "Backup",
  pinnable: false,
  id: "crdb-backup",
  description: "A managed backup of a cluster, restorable onto the same cluster",
  fields: [f("clusterId", "Cluster"), f("backupId", "Backup ID"), f("asOfTime", "Restores To")],
  outputs: [],
  backupRole: { role: "snapshot", sourceKey: "clusterId", createdKey: "asOfTime" },
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "crdb-cluster", label: "backup of" }],
  parentTypeId: "crdb-cluster",
  supportsDelete: false,
  iconKey: "cockroach",
});

export const RestoreType = rt({
  name: "Restore Job",
  pinnable: false,
  id: "crdb-restore",
  description: "A restore of a managed backup",
  fields: [
    f("clusterId", "Cluster"),
    f("type", "Scope"),
    f("status", "Status"),
    f("progressPercent", "Progress (%)", { kind: "number", required: false }),
    f("backupId", "Backup", { required: false }),
    f("backupEndTime", "Backup Taken At", { required: false }),
    f("sourceCluster", "Source Cluster", { required: false }),
    f("objects", "Objects", { required: false }),
    f("error", "Error", { required: false }),
    f("createdAt", "Started At", { required: false }),
    f("completedAt", "Completed At", { required: false }),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsDelete: false,
  iconKey: "cockroach",
});

export const LogExportType = rt({
  name: "Log Export",
  pinnable: false,
  id: "crdb-log-export",
  description:
    "Export of a cluster's logs to CloudWatch, Cloud Logging, Azure Log Analytics or an OTLP endpoint",
  fields: [
    f("type", "Destination", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("status", "Status", ro),
    f("deliveryStatus", "Delivery", ro),
    f("message", "Message", ro),
    f("logName", "Log Name", ro),
    f("region", "Destination Region", ro),
    f("redact", "Redact", { kind: "boolean", ...ro }),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  iconKey: "cockroach",
});

export const MetricExportType = rt({
  name: "Metric Export",
  pinnable: false,
  id: "crdb-metric-export",
  description:
    "Export of a cluster's metrics to Datadog, CloudWatch or a Prometheus scrape endpoint",
  fields: [
    f("kind", "Destination", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("status", "Status", ro),
    f("message", "Message", ro),
    f("target", "Target", ro),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  iconKey: "cockroach",
});

export const BlackoutWindowType = rt({
  name: "Blackout Window",
  pinnable: false,
  id: "crdb-blackout-window",
  description: "A period when CockroachDB Cloud will not apply patch upgrades (Advanced clusters)",
  fields: [
    f("clusterId", "Cluster", { editable: false }),
    f("startTime", "Starts", { description: "ISO time, at least 7 days ahead." }),
    f("endTime", "Ends", { description: "Up to 14 days after the start." }),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const EgressRuleType = rt({
  name: "Egress Rule",
  pinnable: false,
  id: "crdb-egress-rule",
  description: "An allowed outbound destination for a cluster with egress traffic restricted",
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["FQDN", "CIDR"], editable: false }),
    f("destination", "Destination", { editable: false }),
    f("ports", "Ports", {
      required: false,
      description: "Comma-separated; empty allows every port.",
    }),
    f("description", "Description", { required: false }),
    f("state", "State", ro),
    f("managed", "Managed by CockroachDB Cloud", { kind: "boolean", ...ro }),
  ],
  outputs: [],
  dependsOn: dependsOnCluster,
  parentTypeId: "crdb-cluster",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const ServiceAccountType = rt({
  name: "Service Account",
  id: "crdb-service-account",
  description: "A non-human identity whose API keys call the Cloud API",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("roles", "Roles", ro),
    f("orgAdmin", "Organization Admin", { kind: "boolean", ...ro }),
    f("creator", "Created By", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("serviceAccountId", "Service Account ID")],
  principalRole: {
    role: "service-account",
    createdKey: "createdAt",
    adminIndicatorKey: "orgAdmin",
    adminValues: ["true"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const ApiKeyType = rt({
  name: "API Key",
  pinnable: false,
  id: "crdb-api-key",
  description: "An API key of a service account. The secret is shown once, when it is created.",
  fields: [
    f("name", "Name"),
    f("serviceAccountId", "Service Account", { editable: false }),
    f("serviceAccountName", "Service Account Name", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("secret", "Secret", { sensitive: true })],
  dependsOn: [
    { fieldKey: "serviceAccountId", targetTypeId: "crdb-service-account", label: "key of" },
  ],
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "api-token",
      label: "API key due for rotation",
    },
  ],
  principalRole: { role: "key", createdKey: "createdAt", parentKey: "serviceAccountId" },
  parentTypeId: "crdb-service-account",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cockroach",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  OrganizationType,
  FolderType,
  ClusterType,
  DatabaseType,
  SqlUserType,
  AllowlistEntryType,
  BackupType,
  RestoreType,
  LogExportType,
  MetricExportType,
  BlackoutWindowType,
  EgressRuleType,
  ServiceAccountType,
  ApiKeyType,
];

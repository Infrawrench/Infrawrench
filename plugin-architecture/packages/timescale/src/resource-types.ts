import type { PeerGuidanceAction, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { SIZE_IDS } from "./catalog.js";

export const T = {
  project: "ts-project",
  service: "ts-service",
  replica: "ts-read-replica",
  vpc: "ts-vpc",
  peering: "ts-vpc-peering",
  exporter: "ts-exporter",
  allowList: "ts-allow-list",
  backup: "ts-backup",
} as const;

/**
 * Tiger Cloud never returns a service's password after creation, so the
 * PostgreSQL tab offers to set one; Infrawrench keeps it in the host's secret
 * store and builds the connection string from it.
 */
export const setPasswordAction: PeerGuidanceAction = {
  label: "Set tsdbadmin password",
  command: "set-password",
  title: "Set the tsdbadmin password",
  description:
    "Tiger Cloud does not return a service's password once it has been created. Set a new one here and Infrawrench keeps it, so the PostgreSQL tab and the connection string outputs work. Leave the field blank to generate a strong password. Clients using the old password stop connecting.",
  submitLabel: "Set password",
  fields: [
    {
      key: "password",
      label: "New password (optional)",
      kind: "password",
      required: false,
      placeholder: "Leave blank to generate one",
    },
  ],
};

const ProjectType = rt({
  name: "Project",
  id: T.project,
  description:
    "A Tiger Cloud project: the services, VPCs, exporters and IP allow lists a client credential can see",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("services", "Services", { kind: "number", required: false, editable: false }),
    f("planType", "Plan", { required: false, editable: false }),
  ],
  iconKey: "folder",
  pinnable: false,
});

const ServiceType = rt({
  name: "Service",
  id: T.service,
  description:
    "A Tiger Cloud database service: PostgreSQL, optionally with TimescaleDB, with HA replicas, read replicas, a connection pooler and tiered storage",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("serviceId", "Service ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("region", "Region", { editable: false }),
    f("serviceType", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("computeSize", "Compute", {
      kind: "enum",
      enumValues: SIZE_IDS,
      required: false,
      description:
        "CPU millicores / memory GB. Changing it resizes the service, which restarts it (a few seconds of downtime, none with an HA replica).",
    }),
    f("cpuMillis", "CPU (millicores)", { kind: "number", required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("environment", "Environment", {
      kind: "enum",
      enumValues: ["DEV", "PROD"],
      required: false,
      description:
        "PROD services get new TimescaleDB versions three weeks after DEV ones and are flagged when they run without an HA replica.",
    }),
    f("haReplicas", "HA Replicas", {
      kind: "enum",
      enumValues: ["0", "1", "2"],
      required: false,
      description: "0 for none, 1 for high availability, 2 for highest availability.",
    }),
    f("syncReplicas", "Synchronous Replicas", {
      kind: "enum",
      enumValues: ["0", "1"],
      required: false,
      description:
        "1 makes one of two HA replicas synchronous (high data integrity). Needs HA replicas set to 2.",
    }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("poolerEnabled", "Connection Pooler", { kind: "boolean", required: false }),
    f("dataTiering", "Tiered Storage", {
      kind: "boolean",
      required: false,
      description:
        "Moves older chunks to low-cost object storage. Can be turned on here; turning it off needs Tiger Data support.",
    }),
    f("backupRetentionDays", "Backup Retention (days)", {
      kind: "number",
      required: false,
      description: "How many days of backups to keep. Shortening it deletes older backups.",
    }),
    f("host", "Host", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("poolerHost", "Pooler Host", { required: false, editable: false }),
    f("poolerPort", "Pooler Port", { kind: "number", required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vpcHost", "VPC Host", { required: false, editable: false }),
    f("forkedFrom", "Forked From", { required: false, editable: false }),
    f("metricExporterId", "Metric Exporter", { required: false, editable: false }),
    f("logExporterId", "Log Exporter", { required: false, editable: false }),
    f("memoryUsedMb", "Memory Used (MB)", { kind: "number", required: false, editable: false }),
    f("storageUsedMb", "Storage Used (MB)", { kind: "number", required: false, editable: false }),
    f("cpuUsedMillis", "CPU Used (millicores)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("readReplicaSets", "Read Replica Sets", { kind: "number", required: false, editable: false }),
    f("automatedBackups", "Automated Backups", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("database", "Database"),
    o("username", "Username"),
    o("password", "Password", {
      sensitive: true,
      description: "The tsdbadmin password Infrawrench holds for this service",
    }),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "postgresql:// URI for tsdbadmin on the direct endpoint, sslmode=require",
    }),
    o("poolerConnectionString", "Pooled Connection String", {
      sensitive: true,
      description: "The same URI through the connection pooler, when it is enabled",
    }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: T.project, label: "in project" },
    {
      fieldKey: "vpcId",
      targetTypeId: T.vpc,
      matchTemplate: "{projectId}/{vpcId}",
      label: "attached to",
    },
    {
      fieldKey: "forkedFrom",
      targetTypeId: T.service,
      matchTemplate: "{projectId}/{forkedFrom}",
      label: "forked from",
    },
    {
      fieldKey: "metricExporterId",
      targetTypeId: T.exporter,
      matchTemplate: "{projectId}/{metricExporterId}",
      label: "metrics to",
    },
    {
      fieldKey: "logExporterId",
      targetTypeId: T.exporter,
      matchTemplate: "{projectId}/{logExporterId}",
      label: "logs to",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      credentialSetupAction: setPasswordAction,
      unreachableWhen: {
        fieldsEmpty: ["host"],
        title: "This service has no endpoint yet.",
        suggestions: ["Wait for the service to finish provisioning, or resume it if it is paused."],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "database-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for tsdbadmin on the tsdb database",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
    {
      id: "pg-env",
      displayName: "libpq environment",
      description: "PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD",
      entries: [
        { envKey: "PGHOST", outputKey: "host" },
        { envKey: "PGPORT", outputKey: "port" },
        { envKey: "PGDATABASE", outputKey: "database" },
        { envKey: "PGUSER", outputKey: "username" },
        { envKey: "PGPASSWORD", outputKey: "password" },
      ],
    },
  ],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["READY", "CONFIGURING", "UNSTABLE"],
    stoppedValues: ["PAUSED", "PAUSING"],
  },
  backupPolicy: {
    protectedBy: [T.backup],
    automatedBackupFieldKey: "automatedBackups",
    retentionDaysFieldKey: "backupRetentionDays",
  },
  carbon: {
    regionFieldKey: "region",
    grid: "auto",
    vcpus: { from: "field", fieldKey: "vcpus" },
    countFieldKey: "nodeCount",
  },
  postureChecks: [
    {
      id: "timescale-prod-without-ha",
      title: "Production service without an HA replica",
      severity: "low",
      category: "data-protection",
      conditions: [
        { fieldKey: "environment", when: "equals", value: "PROD" },
        { fieldKey: "haReplicas", when: "equals", value: "0" },
      ],
      reason:
        "A PROD service with no HA replica is down for the length of every maintenance restart and every node failure. One HA replica turns those into a switchover of a few seconds.",
    },
  ],
});

const ReplicaType = rt({
  name: "Read Replica Set",
  id: T.replica,
  description:
    "A set of read-only nodes that follow a service, with their own endpoint and optional pooler",
  parentTypeId: T.service,
  fields: [
    f("name", "Name", { editable: false }),
    f("serviceId", "Primary Service", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("nodes", "Nodes", { kind: "number", required: false, editable: false }),
    f("computeSize", "Compute", {
      kind: "enum",
      enumValues: SIZE_IDS,
      required: false,
      description: "CPU millicores / memory GB per node.",
    }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("environment", "Environment", { kind: "enum", enumValues: ["DEV", "PROD"], required: false }),
    f("poolerEnabled", "Connection Pooler", { kind: "boolean", required: false }),
    f("host", "Host", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("poolerHost", "Pooler Host", { required: false, editable: false }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Read-only URI using the primary service's tsdbadmin password",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: T.service,
      matchTemplate: "{projectId}/{serviceId}",
      label: "replicates",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  carbon: {
    regionFieldKey: "region",
    grid: "auto",
    vcpus: { from: "field", fieldKey: "vcpus" },
    countFieldKey: "nodes",
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
});

const VpcType = rt({
  name: "VPC",
  id: T.vpc,
  plural: "VPCs",
  description: "A Tiger Cloud VPC that services attach to and that peers with your AWS VPCs",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("vpcId", "VPC ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("cidr", "CIDR", { editable: false }),
    f("region", "Region", { editable: false }),
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const PeeringType = rt({
  name: "VPC Peering",
  id: T.peering,
  description: "A peering connection between a Tiger Cloud VPC and a VPC in your AWS account",
  parentTypeId: T.vpc,
  fields: [
    f("peerAccountId", "Peer AWS Account", { editable: false }),
    f("peerVpcId", "Peer VPC", { editable: false }),
    f("peerRegion", "Peer Region", { editable: false }),
    f("vpcId", "Tiger VPC", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("provisionedId", "Peering Connection", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "vpcId",
      targetTypeId: T.vpc,
      matchTemplate: "{projectId}/{vpcId}",
      label: "peers",
    },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsDelete: true,
});

const ExporterType = rt({
  name: "Exporter",
  id: T.exporter,
  description:
    "Sends service metrics or logs to Datadog, CloudWatch, Azure Monitor or a Prometheus scrape endpoint (preview API)",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("exporterType", "Destination", { editable: false }),
    f("region", "Region", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("includePgMetrics", "Include PostgreSQL Metrics", { kind: "boolean", required: false }),
    f("datadogSite", "Datadog Site", { required: false, editable: false }),
    f("logGroup", "Log Group", { required: false, editable: false }),
    f("logStream", "Log Stream", { required: false, editable: false }),
    f("awsRegion", "AWS Region", { required: false, editable: false }),
    f("namespace", "CloudWatch Namespace", { required: false, editable: false }),
    f("awsAuth", "AWS Authentication", { required: false, editable: false }),
    f("prometheusUser", "Prometheus Username", { required: false, editable: false }),
    f("prometheusEndpoint", "Scrape Endpoint", { required: false, editable: false }),
    f("attachedServices", "Attached Services", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("prometheusEndpoint", "Prometheus Scrape Endpoint")],
  iconKey: "chart",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  orphanRule: {
    conditions: [{ fieldKey: "attachedServices", when: "empty" }],
    reason: "No service sends data through this exporter.",
  },
});

const AllowListType = rt({
  name: "IP Allow List",
  id: T.allowList,
  description: "The public IP ranges allowed to reach the services it is attached to (preview API)",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("description", "Description"),
    f("cidrBlocks", "CIDR Blocks", {
      description: "Comma-separated public ranges, each /17 or smaller, e.g. 203.0.113.0/24.",
    }),
    f("projectId", "Project ID", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "shield",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const BackupType = rt({
  name: "Backup",
  id: T.backup,
  description: "A full or incremental backup Tiger Cloud took automatically (preview API)",
  parentTypeId: T.service,
  fields: [
    f("label", "Label", { editable: false }),
    f("backupType", "Type", { editable: false }),
    f("serviceId", "Service ID", { editable: false }),
    f("sourceKey", "Source", { required: false, editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("createdAt", "Started", { required: false, editable: false }),
    f("finishedAt", "Finished", { required: false, editable: false }),
    f("durationSeconds", "Duration (s)", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("regions", "Copies", { required: false, editable: false }),
  ],
  iconKey: "backup",
  pinnable: false,
  supportsDelete: false,
  backupRole: { role: "snapshot", sourceKey: "sourceKey", sizeKey: "sizeBytes", sizeUnit: "bytes" },
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ProjectType,
  ServiceType,
  ReplicaType,
  VpcType,
  PeeringType,
  ExporterType,
  AllowListType,
  BackupType,
];

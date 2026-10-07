import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const T = {
  org: "influx-org",
  bucket: "influx-bucket",
  token: "influx-token",
  task: "influx-task",
  check: "influx-check",
  rule: "influx-notification-rule",
  endpoint: "influx-notification-endpoint",
  dashboard: "influx-dashboard",
  telegraf: "influx-telegraf",
  dedicatedDatabase: "influx-dedicated-database",
  dedicatedToken: "influx-dedicated-token",
} as const;

const region = f("region", "Region", { required: false, editable: false });

const OrgType = rt({
  name: "Organization",
  id: T.org,
  description: "The InfluxDB Cloud organization the token belongs to, with its plan limits",
  fields: [
    f("name", "Name", { editable: false }),
    f("orgId", "Organization ID", { editable: false }),
    f("storageEngine", "Storage Engine", { required: false, editable: false }),
    region,
    f("status", "Status", { required: false, editable: false }),
    f("maxBuckets", "Bucket Limit", { kind: "number", required: false, editable: false }),
    f("maxRetentionDays", "Max Retention (days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxTasks", "Task Limit", { kind: "number", required: false, editable: false }),
    f("maxChecks", "Check Limit", { kind: "number", required: false, editable: false }),
    f("writeKBs", "Write Rate Limit (KB/s)", { kind: "number", required: false, editable: false }),
    f("readKBs", "Read Rate Limit (KB/s)", { kind: "number", required: false, editable: false }),
    f("cardinality", "Series Cardinality Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "folder",
  supportsMetrics: true,
});

const BucketType = rt({
  name: "Bucket",
  id: T.bucket,
  description: "A bucket and its retention period; queryable with InfluxQL or Flux",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("bucketId", "Bucket ID", { editable: false }),
    f("orgId", "Organization ID", { editable: false }),
    region,
    f("retentionDays", "Retention (days)", {
      kind: "number",
      required: false,
      description: "How long data is kept. 0 keeps it forever (where the plan allows).",
    }),
    f("schemaType", "Schema", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("storageBytes", "Storage (bytes)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "orgId", targetTypeId: T.org, label: "in" }],
  iconKey: "bucket",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  supportsRestQuery: true,
});

const TokenType = rt({
  name: "API Token",
  id: T.token,
  description: "An API token (authorization) and the permissions it grants",
  fields: [
    f("description", "Description"),
    f("tokenId", "Token ID", { editable: false }),
    f("status", "Status", { kind: "enum", enumValues: ["active", "inactive"], required: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("allAccess", "All Access", { kind: "boolean", required: false, editable: false }),
    f("user", "User", { required: false, editable: false }),
    region,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("token", "Token", { sensitive: true, description: "Only available right after creation" }),
  ],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Token due for rotation" },
  ],
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    adminIndicatorKey: "allAccess",
    revokeActionId: "deactivate",
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "inactive" }],
    reason: "This token is inactive; delete it if nothing will reactivate it.",
  },
});

const TaskType = rt({
  name: "Task",
  id: T.task,
  description: "A scheduled Flux task",
  fields: [
    f("name", "Name"),
    f("taskId", "Task ID", { editable: false }),
    f("status", "Status", { kind: "enum", enumValues: ["active", "inactive"], required: false }),
    f("every", "Every", {
      required: false,
      description: "Duration such as 1h or 15m. Leave empty when using cron.",
    }),
    f("cron", "Cron", { required: false, description: "Cron expression, used instead of Every." }),
    f("offset", "Offset", { required: false }),
    f("description", "Description", { required: false }),
    f("lastRunStatus", "Last Run", { required: false, editable: false }),
    f("lastRunError", "Last Error", { required: false, editable: false }),
    f("latestCompleted", "Latest Completed", { required: false, editable: false }),
    region,
  ],
  iconKey: "clock",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  lifecycle: {
    startActionId: "activate",
    stopActionId: "deactivate",
    statusFieldKey: "status",
    runningValues: ["active"],
    stoppedValues: ["inactive"],
  },
});

const alertFields = [
  f("name", "Name"),
  f("description", "Description", { required: false }),
  f("status", "Status", { kind: "enum", enumValues: ["active", "inactive"], required: false }),
  f("kind", "Type", { required: false, editable: false }),
  region,
];

const CheckType = rt({
  name: "Check",
  id: T.check,
  description: "A threshold or deadman check that writes statuses on a schedule",
  fields: [
    ...alertFields,
    f("every", "Every", { required: false, editable: false }),
    f("lastRunStatus", "Last Run", { required: false, editable: false }),
    f("lastRunError", "Last Error", { required: false, editable: false }),
  ],
  iconKey: "alert",
  supportsUpdate: true,
  supportsDelete: true,
});

const RuleType = rt({
  name: "Notification Rule",
  id: T.rule,
  description: "Sends check statuses to a notification endpoint",
  fields: [
    ...alertFields,
    f("every", "Every", { required: false, editable: false }),
    f("endpointId", "Endpoint", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "endpointId", targetTypeId: T.endpoint, label: "notifies" }],
  iconKey: "bell",
  supportsUpdate: true,
  supportsDelete: true,
});

const EndpointType = rt({
  name: "Notification Endpoint",
  id: T.endpoint,
  description: "A Slack, PagerDuty or HTTP destination for notifications",
  fields: [...alertFields, f("url", "URL", { required: false, editable: false })],
  iconKey: "bell",
  supportsUpdate: true,
  supportsDelete: true,
});

const DashboardType = rt({
  name: "Dashboard",
  id: T.dashboard,
  description: "A dashboard in the InfluxDB Cloud UI",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("cells", "Cells", { kind: "number", required: false, editable: false }),
    region,
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  iconKey: "chart",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const TelegrafType = rt({
  name: "Telegraf Configuration",
  id: T.telegraf,
  description: "A Telegraf agent configuration stored in InfluxDB Cloud",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("buckets", "Buckets", { required: false, editable: false }),
    region,
  ],
  iconKey: "agent",
  pinnable: false,
  supportsDelete: true,
});

const DedicatedDatabaseType = rt({
  name: "Dedicated Database",
  id: T.dedicatedDatabase,
  description: "A database on an InfluxDB 3 Cloud Dedicated cluster",
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("retentionDays", "Retention (days)", {
      kind: "number",
      required: false,
      description: "0 keeps data forever.",
    }),
    f("maxTables", "Max Tables", { kind: "number", required: false }),
    f("maxColumnsPerTable", "Max Columns per Table", { kind: "number", required: false }),
    f("partitionTemplate", "Partition Template", { required: false, editable: false }),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const DedicatedTokenType = rt({
  name: "Dedicated Database Token",
  id: T.dedicatedToken,
  description: "A database token on a Cloud Dedicated cluster",
  fields: [
    f("description", "Description"),
    f("tokenId", "Token ID", { editable: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("allDatabases", "All Databases", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
  ],
  outputs: [
    o("token", "Token", { sensitive: true, description: "Only available right after creation" }),
  ],
  iconKey: "key",
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Database token expires" },
  ],
  principalRole: { role: "key", createdKey: "createdAt", adminIndicatorKey: "allDatabases" },
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrgType,
  BucketType,
  TokenType,
  TaskType,
  CheckType,
  RuleType,
  EndpointType,
  DashboardType,
  TelegrafType,
  DedicatedDatabaseType,
  DedicatedTokenType,
];

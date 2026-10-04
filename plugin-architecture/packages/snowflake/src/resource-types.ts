import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { WAREHOUSE_SIZES } from "./catalog.js";

/**
 * Snowflake resource types. Every listing is a SHOW command over the SQL
 * API; column names verified against the SHOW row structs the Snowflake
 * Terraform provider's SDK scans (`pkg/sdk/*_gen.go`, v2.21.0, 2026-10).
 * Type ids carry a `snowflake-` prefix because names like "database" and
 * "user" are taken by other plugins.
 */

export const TYPE = {
  account: "snowflake-account",
  warehouse: "snowflake-warehouse",
  database: "snowflake-database",
  schema: "snowflake-schema",
  resourceMonitor: "snowflake-resource-monitor",
  user: "snowflake-user",
  role: "snowflake-role",
  task: "snowflake-task",
  pipe: "snowflake-pipe",
  dynamicTable: "snowflake-dynamic-table",
} as const;

const ro = { required: false, editable: false } as const;
const roNum = { kind: "number", required: false, editable: false } as const;
const roBool = { kind: "boolean", required: false, editable: false } as const;

const objectFields = [
  f("database", "Database", ro),
  f("schema", "Schema", ro),
  f("owner", "Owner", ro),
  f("createdOn", "Created", ro),
];

export const AccountResourceType = rt({
  name: "Account",
  id: TYPE.account,
  description:
    "The connected Snowflake account. Shows spend by service, the remaining capacity balance when the role can see organization usage, credits by warehouse, cost attributed to query tags, users, roles and warehouses, and warehouse recommendations.",
  fields: [
    f("name", "Account", { editable: false }),
    f("organization", "Organization", ro),
    f("accountLocator", "Account Locator", ro),
    f("region", "Region", ro),
    f("currentRole", "Role", ro),
    f("currentWarehouse", "Warehouse", ro),
    f("costBasis", "Cost Basis", ro),
    f("monthToDate", "Month-to-Date Cost", roNum),
  ],
  outputs: [o("accountUrl", "Account URL"), o("accountLocator", "Account Locator")],
  supportsMetrics: true,
  iconKey: "account",
});

export const WarehouseResourceType = rt({
  name: "Warehouse",
  id: TYPE.warehouse,
  description:
    "A virtual warehouse: the compute Snowflake bills credits for while it runs. Suspend, resume, resize, change auto-suspend, assign a resource monitor, chart credits and query load, and run SQL on it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("size", "Size", {
      kind: "enum",
      enumValues: WAREHOUSE_SIZES.map((s) => s.show),
      description:
        "Each size up doubles the credits per hour (X-Small is 1 credit an hour) and roughly the compute.",
    }),
    f("autoSuspend", "Auto-Suspend (seconds)", {
      kind: "number",
      required: false,
      description:
        "Seconds of inactivity before the warehouse suspends. 0 means it never suspends. Snowflake bills at least 60 seconds every time a warehouse resumes, so 60 to 300 seconds suits most workloads.",
    }),
    f("autoResume", "Auto-Resume", {
      kind: "boolean",
      required: false,
      description: "Resume automatically when a query arrives.",
    }),
    f("minClusterCount", "Min Clusters", { kind: "number", required: false }),
    f("maxClusterCount", "Max Clusters", {
      kind: "number",
      required: false,
      description: "Above 1 makes this a multi-cluster warehouse (Enterprise edition and up).",
    }),
    f("scalingPolicy", "Scaling Policy", {
      kind: "enum",
      required: false,
      enumValues: ["STANDARD", "ECONOMY"],
      description:
        "STANDARD starts clusters as soon as queries queue; ECONOMY waits until a new cluster would be kept busy for six minutes.",
    }),
    f("queryAcceleration", "Query Acceleration", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
    f("state", "State", ro),
    f("type", "Type", ro),
    f("resourceMonitor", "Resource Monitor", ro),
    f("running", "Running Queries", roNum),
    f("queued", "Queued Queries", roNum),
    f("startedClusters", "Started Clusters", roNum),
    f("generation", "Generation", ro),
    f("credits30d", "Credits (30 days)", roNum),
    f("autoSuspendNever", "Never Auto-Suspends", roBool),
    f("owner", "Owner", ro),
    f("createdOn", "Created", ro),
    f("resumedOn", "Last Resumed", ro),
  ],
  outputs: [o("name", "Warehouse Name")],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "state",
    runningValues: ["STARTED", "RESIZING", "RESUMING"],
    stoppedValues: ["SUSPENDED", "SUSPENDING"],
  },
  orphanRule: {
    conditions: [
      { fieldKey: "autoSuspendNever", when: "equals", value: "true" },
      { fieldKey: "state", when: "equals", value: "STARTED" },
    ],
    reason:
      "Running with auto-suspend turned off, so it bills credits for every idle second until someone suspends it.",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "server",
});

export const DatabaseResourceType = rt({
  name: "Database",
  id: TYPE.database,
  description:
    "A Snowflake database. Shows its storage, Time Travel retention and schemas; change the retention or comment, chart storage, and run SQL in it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("retentionTime", "Time Travel Retention (days)", {
      kind: "number",
      required: false,
      description:
        "Days of Time Travel kept for tables in this database. Longer retention stores more data (0 to 1 on Standard edition, up to 90 on Enterprise).",
    }),
    f("comment", "Comment", { required: false }),
    f("kind", "Kind", ro),
    f("origin", "Origin", ro),
    f("storageBytes", "Storage (bytes)", roNum),
    f("failsafeBytes", "Fail-safe (bytes)", roNum),
    f("owner", "Owner", ro),
    f("createdOn", "Created", ro),
  ],
  outputs: [o("name", "Database Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "database",
});

export const SchemaResourceType = rt({
  name: "Schema",
  id: TYPE.schema,
  parentTypeId: TYPE.database,
  description:
    "A schema in a Snowflake database. Change its retention or comment, or run SQL in it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("retentionTime", "Time Travel Retention (days)", { kind: "number", required: false }),
    f("comment", "Comment", { required: false }),
    f("managedAccess", "Managed Access", roBool),
    f("transient", "Transient", roBool),
    ...objectFields,
  ],
  outputs: [o("qualifiedName", "Qualified Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsRestQuery: true,
  iconKey: "folder",
});

export const ResourceMonitorResourceType = rt({
  name: "Resource Monitor",
  id: TYPE.resourceMonitor,
  description:
    "A credit quota on warehouses or the whole account, with notify and suspend thresholds. Create one, change the quota and thresholds, and assign it to warehouses.",
  fields: [
    f("name", "Name", { editable: false }),
    f("creditQuota", "Credit Quota", {
      kind: "number",
      required: false,
      description: "Credits allowed per interval. Empty means no quota (notifications only).",
    }),
    f("frequency", "Resets", {
      kind: "enum",
      required: false,
      enumValues: ["MONTHLY", "WEEKLY", "DAILY", "YEARLY", "NEVER"],
    }),
    f("notifyAt", "Notify At (%)", {
      required: false,
      description: "Comma-separated percentages of the quota that send an email, e.g. 75,90.",
    }),
    f("suspendAt", "Suspend At (%)", {
      kind: "number",
      required: false,
      description: "Suspend the warehouses once running queries finish.",
    }),
    f("suspendImmediatelyAt", "Suspend Immediately At (%)", {
      kind: "number",
      required: false,
      description: "Suspend the warehouses and cancel running queries.",
    }),
    f("usedCredits", "Used Credits", roNum),
    f("remainingCredits", "Remaining Credits", roNum),
    f("level", "Level", ro),
    f("warehouses", "Warehouses", ro),
    f("startTime", "Starts", ro),
    f("endTime", "Ends", ro),
    f("owner", "Owner", ro),
    f("createdOn", "Created", ro),
  ],
  outputs: [o("name", "Monitor Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const UserResourceType = rt({
  name: "User",
  id: TYPE.user,
  description:
    "A Snowflake user. Shows how it signs in (password, key pair, MFA), its defaults and last login; change the defaults, or disable and re-enable it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("defaultRole", "Default Role", { required: false }),
    f("defaultWarehouse", "Default Warehouse", { required: false }),
    f("comment", "Comment", { required: false }),
    f("loginName", "Login Name", ro),
    f("displayName", "Display Name", ro),
    f("email", "Email", ro),
    f("type", "Type", ro),
    f("disabled", "Disabled", roBool),
    f("hasPassword", "Has Password", roBool),
    f("hasRsaPublicKey", "Has Key Pair", roBool),
    f("hasMfa", "MFA", roBool),
    f("lastSuccessLogin", "Last Login", ro),
    f("owner", "Owner", ro),
    f("createdOn", "Created", ro),
  ],
  outputs: [o("loginName", "Login Name")],
  principalRole: {
    role: "user",
    lastUsedKey: "lastSuccessLogin",
    createdKey: "createdOn",
    adminIndicatorKey: "defaultRole",
    adminValues: ["ACCOUNTADMIN", "SECURITYADMIN", "ORGADMIN", "GLOBALORGADMIN"],
    mfaKey: "hasMfa",
    revokeActionId: "disable",
  },
  supportsUpdate: true,
  iconKey: "user",
});

export const RoleResourceType = rt({
  name: "Role",
  id: TYPE.role,
  description:
    "An account role, with how many users and roles it is granted to and how many roles it inherits. Create, comment or drop roles.",
  fields: [
    f("name", "Name", { editable: false }),
    f("comment", "Comment", { required: false }),
    f("assignedToUsers", "Users", roNum),
    f("grantedToRoles", "Granted to Roles", roNum),
    f("grantedRoles", "Inherited Roles", roNum),
    f("owner", "Owner", ro),
    f("createdOn", "Created", ro),
  ],
  outputs: [o("name", "Role Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const TaskResourceType = rt({
  name: "Task",
  id: TYPE.task,
  description:
    "A scheduled or triggered task. Suspend, resume or run it now, and change its schedule.",
  fields: [
    f("name", "Name", { editable: false }),
    f("schedule", "Schedule", {
      required: false,
      description: "e.g. 60 MINUTE or USING CRON 0 9 * * * UTC. Empty for child tasks.",
    }),
    f("comment", "Comment", { required: false }),
    f("state", "State", ro),
    f("warehouse", "Warehouse", ro),
    f("predecessors", "Runs After", ro),
    f("condition", "Condition", ro),
    f("definition", "Definition", ro),
    f("lastSuspendedReason", "Last Suspended Reason", ro),
    ...objectFields,
  ],
  outputs: [o("qualifiedName", "Qualified Name")],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "state",
    runningValues: ["started"],
    stoppedValues: ["suspended"],
  },
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

export const PipeResourceType = rt({
  name: "Pipe",
  id: TYPE.pipe,
  description:
    "A Snowpipe that loads files from a stage as they arrive. Shows its execution state and pending files; pause, resume or refresh it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("comment", "Comment", { required: false }),
    f("executionState", "Execution State", ro),
    f("pendingFileCount", "Pending Files", roNum),
    f("lastIngested", "Last Ingested", ro),
    f("definition", "Definition", ro),
    f("notificationChannel", "Notification Channel", ro),
    f("integration", "Integration", ro),
    f("pattern", "Pattern", ro),
    f("invalidReason", "Invalid Reason", ro),
    ...objectFields,
  ],
  outputs: [o("qualifiedName", "Qualified Name")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "pipeline",
});

export const DynamicTableResourceType = rt({
  name: "Dynamic Table",
  id: TYPE.dynamicTable,
  description:
    "A dynamic table that Snowflake keeps refreshed from its query. Change the target lag, suspend, resume or refresh it now.",
  fields: [
    f("name", "Name", { editable: false }),
    f("targetLag", "Target Lag", {
      required: false,
      description: "How stale the table may get, e.g. 5 minutes, 1 hour, or DOWNSTREAM.",
    }),
    f("comment", "Comment", { required: false }),
    f("schedulingState", "Scheduling State", ro),
    f("refreshMode", "Refresh Mode", ro),
    f("warehouse", "Warehouse", ro),
    f("rows", "Rows", roNum),
    f("bytes", "Bytes", roNum),
    f("dataTimestamp", "Data As Of", ro),
    ...objectFields,
  ],
  outputs: [o("qualifiedName", "Qualified Name")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "table",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  WarehouseResourceType,
  DatabaseResourceType,
  SchemaResourceType,
  ResourceMonitorResourceType,
  UserResourceType,
  RoleResourceType,
  TaskResourceType,
  PipeResourceType,
  DynamicTableResourceType,
];

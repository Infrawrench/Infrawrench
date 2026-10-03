import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

const connectionMapping = [{ outputKey: "connectionString", credentialKey: "connectionString" }];

export const ManagedDatabaseResourceType = rt({
  id: "rdb-instance",
  name: "Managed Database",
  description: "A Scaleway Managed Database (RDB) instance",
  fields: [
    f("name", "Name"),
    f("engine", "Engine", {
      kind: "enum",
      enumValues: ["PostgreSQL", "MySQL", "Redis"],
      editable: false,
    }),
    f("engineVersion", "Engine Version", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS, editable: false }),
    f("nodeType", "Node Type", {
      description:
        "Instance node type, e.g. DB-DEV-S, db-pro2-xs. Changing it upgrades the instance in place (Scaleway can only scale up)",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("isHaCluster", "High Availability", { kind: "boolean", required: false, editable: false }),
    f("volumeType", "Volume Type", { required: false, editable: false }),
    f("volumeSizeGb", "Volume Size (GB)", {
      kind: "number",
      required: false,
      description: "Storage size; Block (sbs) volumes can grow in place",
    }),
    f("backupsEnabled", "Automatic Backups", { kind: "boolean", required: false, editable: false }),
    f("backupRetentionDays", "Backup Retention (days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("dbName", "Database Name"),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  supportsCreate: true,
  // Edit = rename (`PATCH`) and the in-place upgrades (`POST /upgrade`, one
  // change per call): node type and volume size.
  supportsUpdate: true,
  backupPolicy: {
    protectedBy: [],
    automatedBackupFieldKey: "backupsEnabled",
    retentionDaysFieldKey: "backupRetentionDays",
  },
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: connectionMapping,
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "PostgreSQL" },
    },
    {
      pluginId: "mysql",
      credentialMappings: connectionMapping,
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "MySQL" },
    },
    {
      pluginId: "redis",
      credentialMappings: connectionMapping,
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "Redis" },
    },
  ],
  secretExportTemplates: [
    {
      id: "url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "dbName" },
      ],
    },
  ],
});

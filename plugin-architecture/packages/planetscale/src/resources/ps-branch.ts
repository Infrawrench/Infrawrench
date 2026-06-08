import { f, o, rt } from "@infrawrench/plugin-base";

export const PsBranchResourceType = rt({
  name: "Branch",
  plural: "Branches",
  id: "ps-branch",
  description:
    "A PlanetScale database branch — isolated schema environment with its own connection endpoint",
  fields: [
    f("name", "Name"),
    f("databaseName", "Database"),
    f("parentBranch", "Parent Branch", { required: false }),
    f("production", "Production", { kind: "boolean", required: false }),
    f("ready", "Ready", { kind: "boolean", required: false }),
    f("safeMigrations", "Safe Migrations", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("branchName", "Branch Name"),
    o("databaseName", "Database Name"),
    o("connectionString", "Connection String (MySQL)", { sensitive: true }),
  ],
  parentTypeId: "ps-database",
  supportsCreate: true,
  iconKey: "planetscale",
  attachTargets: [
    {
      pluginId: "planetscale",
      resourceTypeId: "ps-branch",
      matchField: "databaseName",
      verb: "Create deploy request",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for MySQL-compatible connections to this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});

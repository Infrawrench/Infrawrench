import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PsBranchResourceType: ResourceTypeDefinition = {
  id: "ps-branch",
  displayName: "Branch",
  pluralDisplayName: "Branches",
  description: "A PlanetScale database branch — isolated schema environment with its own connection endpoint",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseName", label: "Database", kind: "string", required: true },
    { key: "parentBranch", label: "Parent Branch", kind: "string", required: false },
    { key: "production", label: "Production", kind: "boolean", required: false },
    { key: "ready", label: "Ready", kind: "boolean", required: false },
    { key: "safeMigrations", label: "Safe Migrations", kind: "boolean", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "branchName", label: "Branch Name", sensitive: false },
    { key: "databaseName", label: "Database Name", sensitive: false },
    { key: "connectionString", label: "Connection String (MySQL)", sensitive: true },
  ],
  parentTypeId: "ps-database",
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "planetscale",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for MySQL-compatible connections to this branch",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
      ],
    },
  ],
  resourceSqlDriver: {
    driver: "mysql-planetscale",
    connectionStringOutputKey: "connectionString",
  },
};

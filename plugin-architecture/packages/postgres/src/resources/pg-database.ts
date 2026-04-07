import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PostgresDatabaseResourceType: ResourceTypeDefinition = {
  id: "pg-database",
  displayName: "PostgreSQL Database",
  pluralDisplayName: "PostgreSQL Databases",
  description: "A PostgreSQL database — connects via connection string (literal or from a DO Managed Database)",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Connection String",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description:
        "Connection URI (postgres://...). Can be linked to a DigitalOcean Managed Database.",
      resolvableOutputKeys: ["connectionString"],
      resolvableFrom: [
        {
          pluginId: "digitalocean",
          resourceTypeId: "managed-database",
          outputKey: "connectionString",
        },
      ],
    },
    {
      key: "sslMode",
      label: "SSL Mode",
      kind: "enum",
      required: false,
      enumValues: ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"],
    },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "serverVersion", label: "Server Version", sensitive: false },
    { key: "schemaNames", label: "Schema Names (JSON array)", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "postgres",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full PostgreSQL connection string",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
      ],
    },
  ],
};

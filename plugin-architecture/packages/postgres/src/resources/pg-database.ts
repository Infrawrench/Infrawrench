import { f, o, rt } from "@infrawrench/plugin-base";

export const PostgresDatabaseResourceType = rt({
  name: "PostgreSQL Database",
  id: "pg-database",
  description:
    "A PostgreSQL database — connects via connection string (literal or from a DO Managed Database)",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Connection String", {
      kind: "secret",
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
        {
          pluginId: "neon",
          resourceTypeId: "neon-database",
          outputKey: "connectionString",
        },
      ],
    }),
    f("sslMode", "SSL Mode", {
      kind: "enum",
      required: false,
      enumValues: ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"],
    }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("serverVersion", "Server Version"),
    o("schemaNames", "Schema Names (JSON array)"),
  ],
  iconKey: "postgres",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full PostgreSQL connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});

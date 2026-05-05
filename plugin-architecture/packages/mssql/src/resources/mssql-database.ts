import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MSSQLDatabaseResourceType: ResourceTypeDefinition = {
  id: "mssql-database",
  displayName: "SQL Server Database",
  pluralDisplayName: "SQL Server Databases",
  description: "A Microsoft SQL Server database — connects via connection string.",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Connection String",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description: "Connection URI (mssql://user:pass@host:1433/dbname).",
      resolvableOutputKeys: ["connectionString"],
      resolvableFrom: [],
    },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "serverVersion", label: "Server Version", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "mssql",
};

import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MySQLDatabaseResourceType: ResourceTypeDefinition = {
  id: "mysql-database",
  displayName: "MySQL Database",
  pluralDisplayName: "MySQL Databases",
  description: "A MySQL database — connects via connection string.",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Connection String",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description: "Connection URI (mysql://user:pass@host:3306/dbname).",
      resolvableOutputKeys: ["connectionString"],
      resolvableFrom: [],
    },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "serverVersion", label: "Server Version", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "mysql",
};

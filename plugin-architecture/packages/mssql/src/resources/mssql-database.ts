import { f, o, rt } from "@infrawrench/plugin-base";

export const MSSQLDatabaseResourceType = rt({
  name: "SQL Server Database",
  id: "mssql-database",
  description: "A Microsoft SQL Server database — connects via connection string.",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Connection String", {
      kind: "secret",
      allowLiteral: true,
      description: "Connection URI (mssql://user:pass@host:1433/dbname).",
      resolvableOutputKeys: ["connectionString"],
      resolvableFrom: [],
    }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("serverVersion", "Server Version"),
  ],
  iconKey: "mssql",
});

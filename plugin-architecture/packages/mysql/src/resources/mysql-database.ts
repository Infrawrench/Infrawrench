import { f, o, rt } from "@infrawrench/plugin-base";

export const MySQLDatabaseResourceType = rt({
  name: "MySQL Database",
  id: "mysql-database",
  description: "A MySQL database — connects via connection string.",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Connection String", {
      kind: "secret",
      allowLiteral: true,
      description: "Connection URI (mysql://user:pass@host:3306/dbname).",
      resolvableOutputKeys: ["connectionString"],
      resolvableFrom: [],
    }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("serverVersion", "Server Version"),
  ],
  iconKey: "mysql",
});

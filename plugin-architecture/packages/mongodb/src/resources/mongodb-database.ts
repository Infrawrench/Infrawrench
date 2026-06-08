import { f, o, rt } from "@infrawrench/plugin-base";

export const MongoDBDatabaseResourceType = rt({
  name: "MongoDB Database",
  id: "mongodb-database",
  description: "A MongoDB database — browse collections and documents",
  fields: [
    f("host", "Host", { required: false }),
    f("database", "Database"),
    f("connectionString", "Connection String", { kind: "secret" }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("serverVersion", "Server Version"),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "mongodb",
});

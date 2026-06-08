import { f, o, rt } from "@infrawrench/plugin-base";

export const DatabaseResourceType = rt({
  name: "Database",
  pinnable: false,
  id: "ch-database",
  description: "A database within a ClickHouse Cloud service",
  fields: [
    f("name", "Name"),
    f("engine", "Engine", { required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("databaseName", "Database Name")],
  supportsCreate: true,
  iconKey: "database",
  parentTypeId: "ch-service",
});

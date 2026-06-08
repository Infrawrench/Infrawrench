import { f, o, rt } from "@infrawrench/plugin-base";

export const PostgresSchemaResourceType = rt({
  name: "Schema",
  pinnable: false,
  id: "pg-schema",
  description: "A PostgreSQL schema within a database",
  fields: [f("name", "Schema Name")],
  outputs: [o("tableCount", "Table Count")],
  parentTypeId: "pg-database",
});

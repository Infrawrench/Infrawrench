import { f, o, rt } from "@infrawrench/plugin-base";

export const SchemaResourceType = rt({
  name: "Schema",
  pinnable: false,
  id: "databricks-schema",
  description: "A Unity Catalog schema (namespace for tables within a catalog)",
  fields: [
    f("name", "Name"),
    f("catalogName", "Catalog"),
    f("owner", "Owner", { required: false }),
    f("comment", "Comment", { required: false }),
    f("tableCount", "Tables", { kind: "number", required: false }),
  ],
  outputs: [o("fullName", "Full Name")],
  parentTypeId: "databricks-catalog",
  supportsCreate: true,
});

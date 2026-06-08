import { f, o, rt } from "@infrawrench/plugin-base";

export const GlueDatabaseResourceType = rt({
  name: "Glue Database",
  pinnable: false,
  id: "glue-database",
  description: "An AWS Glue Data Catalog database",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("locationUri", "Location URI", { required: false }),
    f("createTime", "Created", { required: false }),
    f("catalogId", "Catalog ID", { required: false }),
  ],
  outputs: [],
  iconKey: "database",
  supportsCreate: true,
});

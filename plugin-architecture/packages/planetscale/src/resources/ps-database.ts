import { f, o, rt } from "@infrawrench/plugin-base";

export const PsDatabaseResourceType = rt({
  name: "Database",
  id: "ps-database",
  description: "A PlanetScale MySQL-compatible serverless database",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("state", "State", { required: false }),
    f("htmlUrl", "Dashboard URL", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [o("databaseName", "Database Name"), o("region", "Region")],
  supportsCreate: true,
  iconKey: "planetscale",
});

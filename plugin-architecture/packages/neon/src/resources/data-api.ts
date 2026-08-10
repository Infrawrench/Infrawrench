import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonDataApiResourceType = rt({
  name: "Data API",
  id: "neon-data-api",
  description: "A Neon Data API endpoint exposing a branch database over REST",
  fields: [
    f("url", "URL"),
    f("status", "Status", { required: false }),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("database", "Database"),
    f("schemas", "Schemas", { required: false }),
    f("anonymousRole", "Anonymous Role", { required: false }),
  ],
  outputs: [o("url", "URL")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  parentTypeId: "neon-database",
  supportsCreate: true,
  iconKey: "neon",
});

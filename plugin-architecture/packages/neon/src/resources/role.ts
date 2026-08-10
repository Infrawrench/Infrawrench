import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonRoleResourceType = rt({
  name: "Role",
  pinnable: false,
  id: "neon-role",
  description: "A PostgreSQL role within a Neon branch",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("protected", "Protected", { kind: "boolean", required: false }),
  ],
  outputs: [o("password", "Password", { sensitive: true })],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  parentTypeId: "neon-branch",
  supportsCreate: true,
  iconKey: "neon",
});

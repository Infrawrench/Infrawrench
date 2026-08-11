import { f, o, rt } from "@infrawrench/plugin-base";

export const IAMRoleResourceType = rt({
  name: "IAM Role",
  pinnable: false,
  id: "iam-role",
  description: "An AWS Identity and Access Management role",
  fields: [
    f("roleName", "Role Name"),
    f("roleId", "Role ID"),
    f("path", "Path", { required: false }),
    f("createDate", "Created", { required: false }),
    f("description", "Description", { required: false }),
    f("maxSessionDuration", "Max Session (s)", { kind: "number", required: false }),
  ],
  outputs: [o("roleArn", "Role ARN")],
  // No `lastUsedKey`: ListRoles does not return RoleLastUsed, and reading it
  // would mean a GetRole per role. The review therefore reports every role's
  // activity as unknown rather than guessing — which is the point of the
  // contract. Age still comes from `createDate`.
  principalRole: { role: "role", createdKey: "createDate" },
  iconKey: "role",
  supportsCreate: true,
});

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
  iconKey: "role",
  supportsCreate: true,
});

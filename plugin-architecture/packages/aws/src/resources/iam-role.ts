import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const IAMRoleResourceType: ResourceTypeDefinition = {
  id: "iam-role",
  displayName: "IAM Role",
  pluralDisplayName: "IAM Roles",
  description: "An AWS Identity and Access Management role",
  fields: [
    { key: "roleName", label: "Role Name", kind: "string", required: true },
    { key: "roleId", label: "Role ID", kind: "string", required: true },
    { key: "path", label: "Path", kind: "string", required: false },
    { key: "createDate", label: "Created", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "maxSessionDuration", label: "Max Session (s)", kind: "number", required: false },
  ],
  outputs: [{ key: "roleArn", label: "Role ARN", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "role",
};

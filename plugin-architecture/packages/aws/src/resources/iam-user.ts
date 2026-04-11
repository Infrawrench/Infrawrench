import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const IAMUserResourceType: ResourceTypeDefinition = {
  id: "iam-user",
  displayName: "IAM User",
  pluralDisplayName: "IAM Users",
  description: "An AWS Identity and Access Management user",
  fields: [
    { key: "userName", label: "User Name", kind: "string", required: true },
    { key: "userId", label: "User ID", kind: "string", required: true },
    { key: "path", label: "Path", kind: "string", required: false },
    { key: "createDate", label: "Created", kind: "string", required: false },
    { key: "passwordLastUsed", label: "Password Last Used", kind: "string", required: false },
  ],
  outputs: [{ key: "userArn", label: "User ARN", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "user",
};

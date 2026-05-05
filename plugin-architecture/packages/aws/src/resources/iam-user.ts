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
  outputs: [
    { key: "userArn", label: "User ARN", sensitive: false },
    {
      key: "accessKey",
      label: "Access Key (credentials file)",
      sensitive: true,
      description:
        "Creates a new programmatic access key on resolve. Emitted in ini format (`[default]\\naws_access_key_id=…\\naws_secret_access_key=…`). Each resolve creates one key; AWS caps at 2 per user.",
    },
  ],
  dashboardPinnable: false,
  iconKey: "user",
  supportsCreate: true,
  credentialFormats: [
    {
      id: "access-key",
      label: "Access Key",
      description: "Programmatic access key (ID + secret). Limit: 2 keys per user.",
      mediaType: "ini",
      filenameTemplate: "{resource}.credentials",
    },
  ],
};

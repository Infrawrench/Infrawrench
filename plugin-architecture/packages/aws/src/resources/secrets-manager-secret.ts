import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SecretsManagerSecretResourceType: ResourceTypeDefinition = {
  id: "secrets-manager-secret",
  displayName: "Secret",
  pluralDisplayName: "Secrets",
  description: "An AWS Secrets Manager secret",
  fields: [
    { key: "name", label: "Secret Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "lastAccessedDate", label: "Last Accessed", kind: "string", required: false },
    { key: "lastChangedDate", label: "Last Changed", kind: "string", required: false },
    { key: "rotationEnabled", label: "Rotation Enabled", kind: "boolean", required: false },
  ],
  outputs: [
    {
      key: "secretValue",
      label: "Secret Value",
      sensitive: true,
      description: "Current secret value",
    },
    { key: "secretArn", label: "Secret ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "secret",
  secretExportTemplates: [
    {
      id: "secret-value",
      displayName: "Secret Value",
      description: "Inject the secret's current value as an env var",
      entries: [{ envKey: "SECRET_VALUE", outputKey: "secretValue" }],
    },
  ],
};

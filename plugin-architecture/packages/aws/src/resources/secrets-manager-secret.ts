import { f, o, rt } from "@infrawrench/plugin-base";

export const SecretsManagerSecretResourceType = rt({
  name: "Secret",
  id: "secrets-manager-secret",
  description: "An AWS Secrets Manager secret",
  fields: [
    f("name", "Secret Name"),
    f("description", "Description", { required: false }),
    f("lastAccessedDate", "Last Accessed", { required: false }),
    f("lastChangedDate", "Last Changed", { required: false }),
    f("rotationEnabled", "Rotation Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("secretValue", "Secret Value", { sensitive: true, description: "Current secret value" }),
    o("secretArn", "Secret ARN"),
  ],
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
});

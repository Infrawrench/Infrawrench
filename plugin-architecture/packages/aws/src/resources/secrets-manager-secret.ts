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
  // Rotation-age budget over the lister's LastChangedDate: a secret untouched
  // for 90+ days shows as overdue on the expiry radar.
  expiryFields: [
    {
      fieldKey: "lastChangedDate",
      from: "created",
      kind: "secret-version",
      label: "Last rotated",
      maxAgeDays: 90,
    },
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

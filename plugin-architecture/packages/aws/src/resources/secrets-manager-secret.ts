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
    // LastRotatedDate from ListSecrets / DescribeSecret; empty when AWS has
    // never recorded a rotation (null on the wire).
    f("lastRotatedDate", "Last Rotated", { required: false }),
    f("createdDate", "Created", { required: false }),
    f("rotationEnabled", "Rotation Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("secretValue", "Secret Value", { sensitive: true, description: "Current secret value" }),
    o("secretArn", "Secret ARN"),
  ],
  // Rotation-age budget over LastRotatedDate (not LastChangedDate — any secret
  // update would otherwise reset the 90-day clock). Never-rotated secrets keep
  // lastRotatedDate empty and age from createdDate via fallbackFieldKey so the
  // listed field stays honest about "never rotated".
  expiryFields: [
    {
      fieldKey: "lastRotatedDate",
      fallbackFieldKey: "createdDate",
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

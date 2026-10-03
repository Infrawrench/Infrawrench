import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An API key your application issued to one of its organizations through
 * WorkOS API Keys. The full value is returned only when the key is created.
 * Docs: https://workos.com/docs/reference/api-keys
 */
export const OrganizationApiKeyResourceType = rt({
  name: "Organization API Key",
  id: "organization-api-key",
  description:
    "An API key your app issued to an organization with WorkOS API Keys. Create one with permissions and an optional expiry, expire it, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("obfuscatedValue", "Key", { required: false, editable: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("lastUsedAt", "Last used", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("apiKeyId", "API Key ID"),
    o("apiKey", "API Key", {
      sensitive: true,
      description:
        "The full key, returned only when it is created here. WorkOS never shows it again.",
    }),
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    parentKey: "organizationId",
    revokeActionId: "expire",
  },
  parentTypeId: "organization",
  pinnable: false,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "key",
});

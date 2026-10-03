import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A ClickHouse Cloud API key. Keys are created in the console (the secret is
 * shown once there); the API lets Infrawrench rename, enable, disable and
 * delete them, and reports when each was last used.
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "ch-api-key",
  description: "A ClickHouse Cloud organization API key",
  fields: [
    f("keyId", "Key ID", { editable: false }),
    f("name", "Name"),
    f("state", "State", { kind: "enum", enumValues: ["enabled", "disabled"] }),
    f("keySuffix", "Key Suffix", { required: false, editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("isAdmin", "Admin", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "True when an assigned role is an admin role.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expireAt", "Expires", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
    f("ipAccessList", "IP Access List", { required: false, editable: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [
    { fieldKey: "expireAt", from: "expiry", kind: "api-token", label: "API key expires" },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    adminIndicatorKey: "isAdmin",
    revokeActionId: "disable",
  },
  supportsUpdate: true,
  iconKey: "key",
});

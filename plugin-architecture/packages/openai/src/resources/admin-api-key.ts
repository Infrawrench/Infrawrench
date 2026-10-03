import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/organization/admin_api_keys`, `DELETE …/{key_id}`: verified
 * 2026-10-03 against openapi.yaml (`admin-api-keys-list`,
 * `admin-api-keys-delete`). Admin key only.
 *
 * Creation is left to the dashboard: a new admin key is the most privileged
 * credential the organization has, and the value is shown exactly once.
 * Deleting the key this account itself uses locks the plugin out of every
 * admin section.
 */
export const AdminApiKeyResourceType = rt({
  name: "Admin API Key",
  plural: "Admin API Keys",
  id: "admin-api-key",
  description:
    "An organization admin key (sk-admin-…), with its owner, expiry and last use. Revoke from here; create new ones in the OpenAI dashboard. Requires an Admin API key.",
  fields: [
    f("name", "Name", { required: false }),
    f("redactedValue", "Key", { required: false }),
    f("ownerName", "Owner", { required: false }),
    f("ownerId", "Owner ID", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
    f("lastUsedAt", "Last Used", { required: false }),
  ],
  outputs: [o("adminKeyId", "Admin Key ID"), o("redactedValue", "Redacted Value")],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Admin key expires" },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    parentKey: "ownerName",
  },
  iconKey: "key",
  supportsCreate: false,
  supportsDelete: true,
});

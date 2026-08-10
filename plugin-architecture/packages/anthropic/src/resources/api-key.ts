import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An organization API key. Admin-key only.
 *
 * ⚠️ Keys can be **listed and updated but never created or deleted** through
 * the API — "new API keys can only be created through the Claude Console for
 * security reasons." Revoking a key is therefore modelled as an *update*:
 * `POST /v1/organizations/api_keys/{id}` with `{"status":"inactive"}`. That is
 * why this type sets `supportsCreate: false` and `supportsDelete: false`.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin-api/apikeys/list-api-keys
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An organization API key. Requires an Admin API key. Keys cannot be created or deleted through the API — only renamed and moved between active, inactive and archived status.",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "inactive", "archived", "expired"],
    }),
    f("partialKeyHint", "Key Hint", { required: false, editable: false }),
    f("workspaceId", "Workspace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("createdById", "Created By", { required: false, editable: false }),
    f("principalType", "Principal Type", { required: false, editable: false }),
    f("principalId", "Principal ID", { required: false, editable: false }),
  ],
  outputs: [o("apiKeyId", "API Key ID"), o("keyName", "Key Name"), o("status", "Status")],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  parentTypeId: "workspace",
  showInSidebar: true,
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "key",
});

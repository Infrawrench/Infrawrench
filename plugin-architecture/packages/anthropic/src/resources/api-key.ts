import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An organization API key. Admin-key only.
 *
 * ⚠️ Keys can be **listed and updated but never created or deleted** through
 * the API: "new API keys can only be created through the Claude Console for
 * security reasons." Revoking a key is therefore modelled as an *update*:
 * `POST /v1/organizations/api_keys/{id}` with `{"status":"inactive"}`. That is
 * why this type sets `supportsCreate: false` and `supportsDelete: false`.
 *
 * A key either belongs to one workspace (`scope.type` "workspace", which now
 * names the Default Workspace by its real id too) or, for a personal or
 * service-account key bound to a principal, to the whole organization
 * (`scope.type` "organization").
 *
 * Docs: https://platform.claude.com/docs/en/api/organization/api_keys/list
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An organization API key. Requires an Admin API key. Keys can only be renamed and moved between active, inactive and archived; create them in the Console.",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "inactive", "archived", "expired"],
    }),
    f("partialKeyHint", "Key Hint", { required: false, editable: false }),
    f("workspaceId", "Workspace", { required: false, editable: false }),
    f("scopeType", "Scope", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["workspace", "organization"],
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("createdById", "Created By", { required: false, editable: false }),
    f("createdByType", "Created By Type", { required: false, editable: false }),
    f("principalType", "Principal Type", { required: false, editable: false }),
    f("principalId", "Principal ID", { required: false, editable: false }),
  ],
  outputs: [o("apiKeyId", "API Key ID"), o("keyName", "Key Name"), o("status", "Status")],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  // "Deactivate key" is already a plugin-action and is genuinely a revocation
  // rather than a delete (Anthropic has no delete endpoint), so it is exactly
  // what the review's Revoke button should dispatch. No last-used: the Admin
  // API reports none.
  principalRole: {
    role: "key",
    createdKey: "createdAt",
    parentKey: "principalId",
    revokeActionId: "deactivate-key",
  },
  parentTypeId: "workspace",
  showInSidebar: true,
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "key",
});

import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An organization API key.
 *
 * Admin-only: `GET https://api.mistral.ai/v1/admin/api-keys` — a different
 * base *and* a different auth header (`x-api-key`) from the data plane, and
 * gated to Enterprise plans. Without an admin key the listing is empty rather
 * than an error.
 *
 * Pagination here is `limit`/`offset`, unlike voices (`page`/`page_size`) or
 * models (none at all).
 * https://docs.mistral.ai/api/endpoint/beta/admin/api-keys
 */
export const MistralApiKeyResourceType = rt({
  name: "API Key",
  id: "mistral-api-key",
  description: "An organization API key, managed through Mistral's Enterprise-only Admin API",
  fields: [
    f("keyId", "Key ID"),
    f("name", "Name", { required: false }),
    f("hiddenKey", "Masked Key", { required: false }),
    f("workspaceName", "Workspace", { required: false }),
    f("workspaceId", "Workspace ID", { required: false }),
    f("product", "Product", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("lastUsed", "Last Used", { required: false }),
    f("expirationDate", "Expires", { required: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [
    { fieldKey: "expirationDate", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsed",
    createdKey: "createdAt",
    parentKey: "createdBy",
  },
  supportsDelete: true,
  iconKey: "key",
});

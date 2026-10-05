import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Speechmatics API key.
 *
 * Verified against the Management API reference
 * (https://docs.speechmatics.com/api-ref/management/get-all-api-keys,
 * .../create-an-api-key and .../delete-an-api-key): `GET /api-keys?project_id=`,
 * `POST /api-keys?type=` and `DELETE /api-keys/{apikey_id}` on server
 * `https://mp.speechmatics.com/v1`. The list returns
 * `{apikey_id, name, created_at, client_ref}`.
 *
 * The key material itself (`key_value`) is only returned by the create call;
 * the list endpoint returns metadata only.
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An API key issued inside a Speechmatics project. Managed with a management token; the batch API key cannot see these. The secret is shown once, on creation.",
  fields: [
    f("apiKeyId", "API Key ID"),
    f("name", "Name", { required: false }),
    f("clientRef", "Client Reference", { required: false }),
    f("projectId", "Project ID", { required: false }),
    f("projectName", "Project", { required: false }),
    f("product", "Product", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("apiKeyId", "API Key ID"),
    o("apiKeyName", "API Key Name"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "The secret key. Only available on the response that created it.",
    }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", targetKey: "projectId", label: "belongs to" },
  ],
  // Metadata only: the list endpoint returns a creation date and nothing about
  // use, so the review reports the key's age and leaves activity unknown.
  principalRole: { role: "key", createdKey: "createdAt" },
  supportsCreate: true,
  iconKey: "key",
});

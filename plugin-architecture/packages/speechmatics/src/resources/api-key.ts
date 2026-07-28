import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Speechmatics API key.
 *
 * Verified against the Management API reference
 * (https://docs.speechmatics.com/api-ref/management/get-all-api-keys and
 * .../delete-an-api-key) — `GET /api-keys?project_id=` and
 * `DELETE /api-keys/{apikey_id}` on server `https://mp.api.speechmatics.com/v1`,
 * returning an array of `{apikey_id, name, created_at, client_ref}`.
 *
 * The key material itself is only shown once, at creation time; the list
 * endpoint returns metadata only, so there is nothing sensitive to store here.
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An API key issued inside a Speechmatics project. Listed and deleted through the Management API (https://mp.api.speechmatics.com/v1) with a management token — the batch API key cannot see these. The secret value is only revealed once at creation, so only metadata is shown.",
  fields: [
    f("apiKeyId", "API Key ID"),
    f("name", "Name", { required: false }),
    f("clientRef", "Client Reference", { required: false }),
    f("projectId", "Project ID", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("apiKeyId", "API Key ID"), o("apiKeyName", "API Key Name")],
  iconKey: "key",
});

import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A team API key, managed through the Management API on
 * https://management-api.x.ai. Requires the optional management key
 * credential — without it this list is empty.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/management/auth
 * (GET/POST /auth/teams/{teamId}/api-keys, PUT/DELETE /auth/api-keys/{apiKeyId},
 *  POST /auth/api-keys/{apiKeyId}/rotate)
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "A team API key (requires a management key). Create, rename, re-scope, rate-limit, rotate and delete.",
  fields: [
    f("apiKeyId", "API Key ID"),
    f("name", "Name", { required: false }),
    f("redactedApiKey", "Redacted Key", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("acls", "ACLs", { required: false }),
    f("qps", "Queries / second", { kind: "number", required: false }),
    f("qpm", "Queries / minute", { kind: "number", required: false }),
    f("tpm", "Tokens / minute", { required: false }),
    f("expireTime", "Expires", { required: false }),
    f("createTime", "Created", { required: false }),
    f("modifyTime", "Modified", { required: false }),
    f("userId", "Created By", { required: false }),
    f("teamId", "Team ID", { required: false }),
  ],
  outputs: [o("apiKeyId", "API Key ID"), o("redactedApiKey", "Redacted Key")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "key",
});

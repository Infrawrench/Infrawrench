import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An OpenRouter inference key, managed with the account's **management key**.
 * A plain inference key 403s on all of `/keys`.
 *
 * Docs: https://openrouter.ai/openapi.json
 * (GET/POST /keys, GET/PATCH/DELETE /keys/{hash})
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An OpenRouter inference key with its own spend limit, reset interval and expiry (requires a management key)",
  fields: [
    f("hash", "Key Hash"),
    f("name", "Name", { required: false }),
    f("label", "Label", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("limit", "Credit Limit", { kind: "number", required: false }),
    f("limitRemaining", "Limit Remaining", { kind: "number", required: false }),
    f("limitReset", "Limit Reset", { required: false }),
    f("usage", "Usage", { kind: "number", required: false }),
    f("usageDaily", "Usage (day)", { kind: "number", required: false }),
    f("usageWeekly", "Usage (week)", { kind: "number", required: false }),
    f("usageMonthly", "Usage (month)", { kind: "number", required: false }),
    f("byokUsage", "BYOK Usage", { kind: "number", required: false }),
    f("includeByokInLimit", "BYOK Counts Toward Limit", { kind: "boolean", required: false }),
    f("expiresAt", "Expires", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
    f("workspaceId", "Workspace ID", { required: false }),
    f("creatorUserId", "Created By", { required: false }),
  ],
  outputs: [
    o("hash", "Key Hash"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "Plaintext key — only ever returned by the create call",
    }),
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "key",
});

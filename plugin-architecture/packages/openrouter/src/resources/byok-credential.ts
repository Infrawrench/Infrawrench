import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A bring-your-own-key provider credential: your own key for an upstream
 * provider, which OpenRouter uses before (or instead of) its own capacity.
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/byok/list-byok-provider-credentials
 * (GET/POST /byok, GET/PATCH/DELETE /byok/{id})
 */
export const ByokCredentialResourceType = rt({
  name: "BYOK Credential",
  id: "byok-credential",
  description:
    "Your own API key for an upstream provider, used by OpenRouter before its own capacity (requires a management key)",
  fields: [
    f("name", "Name", { required: false }),
    f("credentialId", "Credential ID", { editable: false }),
    f("provider", "Provider", { editable: false }),
    f("label", "Key", { required: false, editable: false }),
    f("workspaceId", "Workspace ID", { required: false, editable: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("isFallback", "Fall Back to OpenRouter Credits", { kind: "boolean", required: false }),
    f("isByokOnly", "BYOK Only", { kind: "boolean", required: false }),
    f("isRequired", "Required", { kind: "boolean", required: false }),
    f("declaredZdr", "Declared Zero Data Retention", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("allowedModels", "Allowed Models", {
      required: false,
      description: "Comma-separated model ids this key may serve. Empty allows all.",
    }),
    f("restrictedToKeys", "Restricted to API Keys", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("sortOrder", "Priority", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("credentialId", "Credential ID"), o("provider", "Provider Slug")],
  dependsOn: [
    { fieldKey: "provider", targetTypeId: "provider", label: "authenticates" },
    { fieldKey: "workspaceId", targetTypeId: "workspace", label: "belongs to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "key",
});

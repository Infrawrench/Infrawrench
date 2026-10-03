import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An OpenRouter guardrail: a spend limit plus routing policy (allowed and
 * blocked providers and models, data regions, zero data retention, training
 * opt-ins) applied to the API keys and members assigned to it.
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/guardrails/list-guardrails
 * (GET/POST /guardrails, GET/PATCH/DELETE /guardrails/{id},
 * POST /guardrails/{id}/assignments/keys)
 */
export const GuardrailResourceType = rt({
  name: "Guardrail",
  id: "guardrail",
  description:
    "A spend limit and routing policy (providers, models, data regions, zero data retention) applied to API keys (requires a management key)",
  fields: [
    f("name", "Name"),
    f("guardrailId", "Guardrail ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("workspaceId", "Workspace ID", { required: false, editable: false }),
    f("limitUsd", "Spend Limit (USD)", {
      kind: "number",
      required: false,
      description: "0 or blank for no limit.",
    }),
    f("resetInterval", "Limit Resets", {
      kind: "enum",
      enumValues: ["never", "daily", "weekly", "monthly"],
      required: false,
    }),
    f("includeByokInBudgets", "BYOK Counts Toward Limit", { kind: "boolean", required: false }),
    f("allowedProviders", "Allowed Providers", {
      required: false,
      description:
        "Comma-separated provider slugs, as shown on the Providers list. Empty allows all.",
    }),
    f("ignoredProviders", "Blocked Providers", {
      required: false,
      description: "Comma-separated provider slugs.",
    }),
    f("allowedModels", "Allowed Models", {
      required: false,
      description: "Comma-separated model ids, as shown on the Models list. Empty allows all.",
    }),
    f("ignoredModels", "Blocked Models", {
      required: false,
      description: "Comma-separated model ids.",
    }),
    f("allowedDataRegions", "Allowed Data Regions", {
      required: false,
      description: "Comma-separated: global, us, europe. Empty allows any.",
    }),
    f("enforceZdr", "Require Zero Data Retention", { kind: "boolean", required: false }),
    f("enablePaidModelTraining", "Allow Paid-Model Training", { kind: "boolean", required: false }),
    f("enableFreeModelTraining", "Allow Free-Model Training", { kind: "boolean", required: false }),
    f("enableFreeModelPublication", "Allow Free-Model Publication", {
      kind: "boolean",
      required: false,
    }),
    f("contentFilters", "Content Filters", { kind: "number", required: false, editable: false }),
    f("assignedKeys", "Assigned API Keys", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("guardrailId", "Guardrail ID")],
  dependsOn: [{ fieldKey: "workspaceId", targetTypeId: "workspace", label: "belongs to" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "shield",
});

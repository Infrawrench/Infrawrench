import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An OpenRouter workspace: a partition of keys, guardrails and BYOK
 * credentials with its own defaults, observability settings and budgets.
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/workspaces/list-workspaces
 * (GET/POST /workspaces, GET/PATCH/DELETE /workspaces/{id},
 * GET /workspaces/{ref}/budgets, PUT/DELETE /workspaces/{ref}/budgets/{interval})
 */
export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description:
    "An OpenRouter workspace with its own default models, observability settings and daily/weekly/monthly/lifetime budgets (requires a management key)",
  fields: [
    f("name", "Name"),
    f("workspaceId", "Workspace ID", { editable: false }),
    f("slug", "Slug", { required: false }),
    f("description", "Description", { required: false }),
    f("defaultTextModel", "Default Text Model", {
      required: false,
      description: "A model id from the Models list, e.g. openai/gpt-4o. Blank for none.",
    }),
    f("defaultImageModel", "Default Image Model", {
      required: false,
      description: "A model id from the Models list. Blank for none.",
    }),
    f("defaultProviderSort", "Default Provider Sort", {
      kind: "enum",
      enumValues: ["default", "price", "throughput", "latency", "exacto"],
      required: false,
    }),
    f("defaultGuardrailId", "Default Guardrail", { required: false, editable: false }),
    f("budgetDaily", "Daily Budget (USD)", {
      kind: "number",
      required: false,
      description: "0 or blank removes the budget.",
    }),
    f("budgetWeekly", "Weekly Budget (USD)", { kind: "number", required: false }),
    f("budgetMonthly", "Monthly Budget (USD)", { kind: "number", required: false }),
    f("budgetLifetime", "Lifetime Budget (USD)", { kind: "number", required: false }),
    f("includeByokInBudgets", "BYOK Counts Toward Budgets", { kind: "boolean", required: false }),
    f("ioLoggingEnabled", "I/O Logging", { kind: "boolean", required: false }),
    f("ioLoggingSamplingRate", "I/O Logging Sample Rate", {
      kind: "number",
      required: false,
      description: "Fraction of requests logged, from 0 to 1.",
    }),
    f("broadcastEnabled", "Broadcast to Observability Destinations", {
      kind: "boolean",
      required: false,
    }),
    f("dataDiscountLoggingEnabled", "Data-Discount Logging", { kind: "boolean", required: false }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("workspaceId", "Workspace ID"), o("slug", "Workspace Slug")],
  supportsCreate: true,
  supportsUpdate: true,
  // Analytics API (`POST /analytics/query`) series filtered to this workspace.
  supportsMetrics: true,
  iconKey: "workspace",
});

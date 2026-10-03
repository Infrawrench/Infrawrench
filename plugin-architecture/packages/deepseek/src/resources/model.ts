import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One model the API key can call. DeepSeek's list is deliberately tiny
 * (`deepseek-flash` and `deepseek-v4-pro` as of the V4.1-Flash release), but
 * `GET /models` now returns real metadata alongside the OpenAI-compatible
 * `{id, object, owned_by}` triple: a display name, the context window, the
 * output cap, input/output modalities, the supported thinking-effort levels,
 * and how the Anthropic-compatible endpoint treats a system prompt update.
 *
 * The per-model concurrency limit and the price sheet are documented rather
 * than returned by the API, so the client fills them in from DeepSeek's
 * published tables.
 *
 * Docs: https://api-docs.deepseek.com/api/list-models
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A DeepSeek model available to this API key, with its context window, output cap, modalities and thinking-effort levels. DeepSeek publishes a concurrency cap per model rather than an RPM/TPM rate limit.",
  fields: [
    f("modelId", "Model ID", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("ownedBy", "Owned By", { required: false, editable: false }),
    f("contextWindow", "Context Window", { kind: "number", required: false, editable: false }),
    f("maxOutputTokens", "Max Output Tokens", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("inputModalities", "Input Modalities", { required: false, editable: false }),
    f("outputModalities", "Output Modalities", { required: false, editable: false }),
    f("effortLevels", "Thinking Effort Levels", { required: false, editable: false }),
    f("defaultEffort", "Default Thinking Effort", { required: false, editable: false }),
    f("anthropicSystemPromptUpdate", "Anthropic System Prompt Updates", {
      required: false,
      editable: false,
    }),
    f("concurrencyLimit", "Concurrency Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("legacyAliases", "Legacy Aliases", { required: false, editable: false }),
  ],
  outputs: [
    o("modelId", "Model ID", {
      description: "Value to pass as the `model` parameter on POST /chat/completions.",
    }),
    o("contextWindow", "Context Window", { description: "Maximum context length in tokens." }),
  ],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "model",
});

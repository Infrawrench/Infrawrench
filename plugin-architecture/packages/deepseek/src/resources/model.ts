import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One model the API key can call. DeepSeek's list is deliberately tiny —
 * `deepseek-v4-flash` and `deepseek-v4-pro` — and the response carries no
 * pricing, context window, or capability metadata, only the OpenAI-compatible
 * `{id, object, owned_by}` triple.
 *
 * The per-model concurrency limit is documented rather than returned by the
 * API, so the client fills it in from DeepSeek's published table.
 *
 * Docs: https://api-docs.deepseek.com/api/list-models
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A DeepSeek model available to this API key. The API returns only id and owner — DeepSeek publishes a concurrency cap per model rather than an RPM/TPM rate limit.",
  fields: [
    f("modelId", "Model ID", { editable: false }),
    f("ownedBy", "Owned By", { required: false, editable: false }),
    f("concurrencyLimit", "Concurrency Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("modelId", "Model ID", {
      description: "Value to pass as the `model` parameter on POST /chat/completions.",
    }),
  ],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "model",
});

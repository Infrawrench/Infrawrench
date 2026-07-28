import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model served by the Cohere Platform.
 *
 * Verified: https://docs.cohere.com/reference/list-models
 * `GET /v1/models` → `{ models: [...], next_page_token }`.
 *
 * The model detail view carries the Speech tab — Cohere's transcription
 * endpoint is addressed by model id, so the model is the natural home for it.
 *
 * ⚠️ `is_deprecated` models stay in the list, so anything that builds a picker
 * has to filter on it. `supports_vision` is deliberately absent: it is not in
 * the documented schema.
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description: "A Cohere model available for chat, embed, rerank, or classification",
  fields: [
    f("name", "Name"),
    f("endpoints", "Endpoints", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("features", "Features", { required: false }),
    f("finetuned", "Fine-tuned", { kind: "boolean", required: false }),
    f("isDeprecated", "Deprecated", { kind: "boolean", required: false }),
    f("defaultEndpoints", "Default Endpoints", { required: false }),
    f("tokenizerUrl", "Tokenizer URL", { required: false }),
    f("samplingDefaults", "Sampling Defaults", { required: false }),
  ],
  outputs: [
    o("modelName", "Model Name", { description: "Model id to pass as `model` in API calls" }),
    o("contextLength", "Context Length", { description: "Maximum context window in tokens" }),
    o("endpoint", "API Base URL", { description: "https://api.cohere.com" }),
  ],
  // Base models belong to Cohere.
  supportsDelete: false,
  iconKey: "model",
});

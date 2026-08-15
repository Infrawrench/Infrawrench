import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model in the OpenRouter catalogue.
 *
 * Docs: https://openrouter.ai/openapi.json  (GET /models — `limit` max 1000,
 * `offset` for pagination; modality filters via `output_modalities`).
 * Prices arrive as decimal strings in USD *per token*; the plugin normalises
 * them to per-million-token numbers so the list is comparable at a glance.
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model routable through OpenRouter, with per-million-token pricing, context length and modalities",
  fields: [
    f("modelId", "Model ID"),
    f("name", "Name", { required: false }),
    f("canonicalSlug", "Canonical Slug", { required: false }),
    f("author", "Author", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("modality", "Modality", { required: false }),
    f("inputModalities", "Input Modalities", { required: false }),
    f("outputModalities", "Output Modalities", { required: false }),
    f("tokenizer", "Tokenizer", { required: false }),
    f("created", "Created", { required: false }),
    f("knowledgeCutoff", "Knowledge Cutoff", { required: false }),
    f("expirationDate", "Expires", { required: false }),
    f("huggingFaceId", "Hugging Face ID", { required: false }),
    f("description", "Description", { required: false }),
    // Normalised to USD per 1M tokens (per 1K for image/request meters).
    f("promptPricePerMillion", "Prompt Price (per 1M)", { kind: "number", required: false }),
    f("completionPricePerMillion", "Completion Price (per 1M)", {
      kind: "number",
      required: false,
    }),
    f("imagePrice", "Image Price", { kind: "number", required: false }),
    f("requestPrice", "Request Price", { kind: "number", required: false }),
    f("webSearchPrice", "Web Search Price", { kind: "number", required: false }),
    f("supportedParameters", "Supported Parameters", { required: false }),
    f("supportedVoices", "Supported Voices", { required: false }),
    f("topProviderContextLength", "Top Provider Context", { kind: "number", required: false }),
    f("topProviderMaxCompletionTokens", "Top Provider Max Completion", {
      kind: "number",
      required: false,
    }),
    f("isModerated", "Moderated", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", { description: "Pass as `model` in inference requests" }),
    o("canonicalSlug", "Canonical Slug"),
  ],
  // The detail view has offered a Metrics tab since it was written, but the
  // host only calls `fetchMetricSeries` for types that declare this — so the
  // per-model spend and request series from `/activity` never reached it.
  supportsMetrics: true,
  iconKey: "cpu",
});

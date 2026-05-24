import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VertexGeminiModelResourceType: ResourceTypeDefinition = {
  id: "vertex-gemini-model",
  displayName: "Gemini Model",
  pluralDisplayName: "Gemini Models",
  description:
    "A Vertex AI Gemini chat model. Open one to chat with it in the Playground tab via Vertex AI's OpenAI-compatible streaming endpoint.",
  fields: [
    { key: "modelId", label: "Model ID", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};

/**
 * Curated list of current Vertex AI Gemini chat models. Vertex's
 * `publishers/google/models` listing endpoint is awkward and inconsistent
 * (mixes deprecated/tuned/embedding entries and paginates oddly), so we ship
 * a static catalog of the chat-capable Gemini ids instead. The `model`
 * parameter sent to the OpenAI-compatible endpoint is `google/{modelId}`.
 */
export const VERTEX_GEMINI_MODELS: ReadonlyArray<{ modelId: string; description: string }> = [
  { modelId: "gemini-2.5-pro", description: "Most capable Gemini 2.5 reasoning model" },
  { modelId: "gemini-2.5-flash", description: "Fast, cost-efficient Gemini 2.5 model" },
  { modelId: "gemini-2.0-flash", description: "Fast multimodal Gemini 2.0 model" },
  { modelId: "gemini-2.0-flash-lite", description: "Lowest-cost, lowest-latency Gemini 2.0 model" },
  { modelId: "gemini-1.5-pro", description: "Long-context Gemini 1.5 model" },
  { modelId: "gemini-1.5-flash", description: "Fast, lightweight Gemini 1.5 model" },
];

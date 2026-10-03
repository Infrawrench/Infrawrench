import { f, rt } from "@infrawrench/plugin-base";

export const VertexGeminiModelResourceType = rt({
  name: "Gemini Model",
  pinnable: false,
  id: "vertex-gemini-model",
  description:
    "A Vertex AI Gemini chat model. Open one to chat with it in the Playground tab via Vertex AI's OpenAI-compatible streaming endpoint.",
  fields: [f("modelId", "Model ID"), f("description", "Description", { required: false })],
  outputs: [],
});

/**
 * Curated list of current Vertex AI Gemini chat models. Vertex's
 * `publishers/google/models` listing endpoint is awkward and inconsistent
 * (mixes deprecated/tuned/embedding entries and paginates oddly), so we ship
 * a static catalog of the chat-capable Gemini ids instead. The `model`
 * parameter sent to the OpenAI-compatible endpoint is `google/{modelId}`.
 *
 * Text chat models only: image, TTS, Live, transcription and embedding
 * variants don't speak chat completions. Gemini 2.0 and 1.5 are shut down;
 * the 3.x previews are served from the `global` location only, which is why
 * the playground calls the global endpoint.
 */
export const VERTEX_GEMINI_MODELS: ReadonlyArray<{ modelId: string; description: string }> = [
  {
    modelId: "gemini-3.8-flash",
    description: "Most capable Flash model, for coding and agentic work",
  },
  { modelId: "gemini-3.7-flash", description: "Previous-generation Flash for complex coding" },
  {
    modelId: "gemini-3.6-flash",
    description: "Previous-generation Flash balancing speed and capability",
  },
  { modelId: "gemini-3.5-flash", description: "Gemini 3.5 Flash for routine workloads" },
  {
    modelId: "gemini-3.5-flash-lite",
    description: "Fastest, most cost-effective Gemini 3.5 model",
  },
  { modelId: "gemini-3.1-flash-lite", description: "Low-cost Gemini 3.1 model" },
  {
    modelId: "gemini-3.1-pro-preview",
    description: "Gemini 3.1 Pro (Preview) for advanced reasoning",
  },
  { modelId: "gemini-3-flash-preview", description: "Gemini 3 Flash (Preview)" },
  { modelId: "gemini-2.5-pro", description: "Gemini 2.5 reasoning model" },
  { modelId: "gemini-2.5-flash", description: "Fast, cost-efficient Gemini 2.5 model" },
  { modelId: "gemini-2.5-flash-lite", description: "Lowest-cost Gemini 2.5 model" },
];

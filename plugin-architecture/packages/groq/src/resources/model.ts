import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model served by GroqCloud.
 *
 * Always populated from `GET https://api.groq.com/openai/v1/models` — Groq
 * runs a rolling deprecation schedule (see console.groq.com/docs/deprecations),
 * so a hardcoded catalogue goes stale within weeks.
 */
export const GroqModelResourceType = rt({
  name: "Model",
  id: "groq-model",
  description: "A model served by GroqCloud — chat, transcription, or speech synthesis",
  fields: [
    f("modelId", "Model ID"),
    f("ownedBy", "Owned By", { required: false }),
    f("modality", "Modality", { required: false }),
    f("contextWindow", "Context Window", { kind: "number", required: false }),
    f("maxCompletionTokens", "Max Completion Tokens", { kind: "number", required: false }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("created", "Created", { required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("baseUrl", "OpenAI-Compatible Base URL")],
  supportsDelete: false,
  iconKey: "cpu",
});

import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A base model served by the Gemini API on AI Studio.
 *
 * Verified: https://ai.google.dev/api/models
 * `GET /v1beta/models?pageSize=&pageToken=` → `{ models: [...], nextPageToken }`.
 * `pageSize` defaults to 50 and the endpoint returns at most 1000 per page.
 * `GET /v1beta/models/{id}` returns a single model.
 *
 * The `Model` schema is exactly the thirteen fields below — including the
 * `thinking` boolean, which marks models that emit reasoning tokens.
 *
 * This type also carries the Speech tab: Gemini's TTS and audio-understanding
 * are both addressed by model id, so the model *is* the speech resource.
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description: "A Gemini base model, with its token limits and supported generation methods",
  fields: [
    f("name", "Resource Name"),
    f("baseModelId", "Base Model ID", { required: false }),
    f("displayName", "Display Name", { required: false }),
    f("version", "Version", { required: false }),
    f("descriptionText", "Description", { required: false }),
    f("inputTokenLimit", "Input Token Limit", { kind: "number", required: false }),
    f("outputTokenLimit", "Output Token Limit", { kind: "number", required: false }),
    f("supportedGenerationMethods", "Supported Generation Methods", { required: false }),
    f("thinking", "Thinking", { kind: "boolean", required: false }),
    f("temperature", "Default Temperature", { kind: "number", required: false }),
    f("maxTemperature", "Max Temperature", { kind: "number", required: false }),
    f("topP", "Top P", { kind: "number", required: false }),
    f("topK", "Top K", { kind: "number", required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", {
      description: 'Short id such as "gemini-2.5-flash", for the `model` field of a request',
    }),
    o("modelName", "Resource Name", {
      description: 'Fully-qualified name, e.g. "models/gemini-2.5-flash"',
    }),
    o("endpoint", "API Base URL", {
      description: "https://generativelanguage.googleapis.com/v1beta",
    }),
    o("inputTokenLimit", "Input Token Limit"),
    o("outputTokenLimit", "Output Token Limit"),
  ],
  // Base models belong to Google.
  supportsDelete: false,
  iconKey: "model",
});

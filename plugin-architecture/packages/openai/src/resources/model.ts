import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/models` — verified 2026-07-29 against the published OpenAI OpenAPI
 * description (openapi.yaml v2.3.0, `listModels`). The list is flat: no
 * pagination parameters and no envelope beyond `{ object, data }`.
 *
 * This is also where the Speech tab lives: TTS and STT are model-scoped in the
 * OpenAI API, so the playground hangs off whichever model the user opened.
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model this API key can call — base models plus any fine-tuned snapshots the organization owns. Text-to-speech and transcription are exercised from the Speech tab.",
  fields: [
    f("modelId", "Model ID"),
    f("ownedBy", "Owned By", { required: false }),
    f("created", "Created", { required: false }),
    f("isFineTuned", "Fine-tuned", { kind: "boolean", required: false }),
    f("supportsTts", "Text-to-speech", { kind: "boolean", required: false }),
    f("supportsStt", "Transcription", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", { description: "Value to pass as `model` in an API request" }),
    o("ownedBy", "Owner", { description: "Organization that owns the model" }),
  ],
  iconKey: "model",
  supportsMetrics: true,
  // Only fine-tuned models can be deleted, so the affordance is a conditional
  // header action in `renderDetail` rather than the host's blanket delete button.
  supportsDelete: false,
});

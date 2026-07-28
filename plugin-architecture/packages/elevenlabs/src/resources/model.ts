import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An ElevenLabs speech model (eleven_v3, eleven_multilingual_v2, eleven_flash_v2_5, …).
 * Listed from `GET /v1/models`.
 * https://elevenlabs.io/docs/api-reference/models/list
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description: "A speech model available to this ElevenLabs workspace",
  fields: [
    f("name", "Name"),
    f("modelId", "Model ID"),
    f("description", "Description", { required: false }),
    f("maxCharacters", "Max Characters Per Request", { kind: "number", required: false }),
    f("canDoTextToSpeech", "Text-to-Speech", { kind: "boolean", required: false }),
    f("canDoVoiceConversion", "Voice Conversion", { kind: "boolean", required: false }),
    f("canUseStyle", "Supports Style", { kind: "boolean", required: false }),
    f("canUseSpeakerBoost", "Supports Speaker Boost", { kind: "boolean", required: false }),
    f("requiresAlphaAccess", "Requires Alpha Access", { kind: "boolean", required: false }),
    f("languageCount", "Languages", { kind: "number", required: false }),
    f("languages", "Language Codes", { required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", { description: "The model_id passed to text-to-speech requests" }),
    o("maxCharacters", "Max Characters Per Request"),
  ],
  iconKey: "model",
  supportsDelete: false,
});

import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A TTS voice usable as `voice_id` on POST /v1/tts.
 *
 * Deliberately covers both halves of xAI's voice surface so the user gets one
 * "Voices" list instead of having to know which endpoint a voice came from:
 *   - built-in voices  — GET /v1/tts/voices
 *   - cloned voices    — GET /v1/custom-voices  (POST/PATCH/DELETE too)
 *
 * `builtIn` distinguishes them; only cloned voices can be edited or deleted.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/inference/voice
 */
export const CustomVoiceResourceType = rt({
  name: "Voice",
  plural: "Voices",
  id: "custom-voice",
  description:
    "A text-to-speech voice — xAI's built-in voices plus any custom voices cloned by this team",
  fields: [
    f("voiceId", "Voice ID"),
    f("name", "Name", { required: false }),
    f("builtIn", "Built-in", { kind: "boolean", required: false }),
    f("description", "Description", { required: false }),
    f("gender", "Gender", { required: false }),
    f("accent", "Accent", { required: false }),
    f("age", "Age", { required: false }),
    f("language", "Language", { required: false }),
    f("useCase", "Use Case", { required: false }),
    f("tone", "Tone", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID", { description: "Pass as `voice_id` in POST /v1/tts" }),
    o("name", "Voice Name"),
  ],
  supportsUpdate: true,
  iconKey: "mic",
});

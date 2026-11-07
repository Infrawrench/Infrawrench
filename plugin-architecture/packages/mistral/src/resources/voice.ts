import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A text-to-speech voice: either one of Mistral's presets or a clone the
 * workspace created from an audio sample.
 *
 * `GET https://api.mistral.ai/v2/audio/voices`: paginated with
 * `page_token`/`page_size`. Editing and deleting a voice are still on `/v1`.
 * https://docs.mistral.ai/api/endpoint/audio/voices
 */
export const MistralVoiceResourceType = rt({
  name: "Voice",
  id: "mistral-voice",
  description: "A Mistral TTS voice: a built-in preset or a workspace voice clone",
  fields: [
    f("voiceId", "Voice ID"),
    f("name", "Name", { required: false }),
    f("slug", "Slug", { required: false }),
    f("gender", "Gender", { required: false }),
    f("age", "Age", { kind: "number", required: false }),
    f("languages", "Languages", { required: false }),
    f("description", "Description", { required: false }),
    f("tags", "Tags", { required: false }),
    f("custom", "Custom Clone", { kind: "boolean", required: false }),
    f("createdAt", "Created", { showcase: true, required: false }),
  ],
  outputs: [o("voiceId", "Voice ID"), o("name", "Voice Name")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "mic",
});

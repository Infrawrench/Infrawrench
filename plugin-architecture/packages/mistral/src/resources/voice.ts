import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A text-to-speech voice — either one of Mistral's presets or a clone the
 * workspace created from an audio sample.
 *
 * `GET https://api.mistral.ai/v1/audio/voices` — paginated with
 * `limit`/`offset`, and the response envelope reports `page`/`page_size`/
 * `total`/`total_pages`. Neither scheme matches `/models` (none) or the admin
 * API, which is why this plugin has no single shared paginator.
 * https://docs.mistral.ai/api/endpoint/audio/voices
 */
export const MistralVoiceResourceType = rt({
  name: "Voice",
  id: "mistral-voice",
  description: "A Mistral TTS voice — a built-in preset or a workspace voice clone",
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
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("voiceId", "Voice ID"), o("name", "Voice Name")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "mic",
});

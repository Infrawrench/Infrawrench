import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A custom TTS voice stored in the project: designed from a text prompt
 * (`prompted`) or replicated from reference audio (`replicated`). Prebuilt
 * catalogue voices are not listed here; they are already in every Speech
 * tab's picker.
 *
 * Verified: https://ai.google.dev/api/voices (Beta, `/v1beta/voices`)
 * `GET /v1beta/voices?type=prompted&type=replicated` →
 * `{ voices: [...], next_page_token }`, snake_case fields. Stored voices
 * expire after a year of inactivity; using one extends `expire_time`. There
 * is no update method.
 */
export const VoiceResourceType = rt({
  name: "Custom Voice",
  id: "voice",
  description:
    "A custom text-to-speech voice designed from a description or replicated from a recording, usable by id in any Gemini TTS request",
  fields: [
    f("displayName", "Name", { required: false }),
    f("voiceId", "Voice ID"),
    f("type", "Type", { kind: "enum", enumValues: ["prompted", "replicated"] }),
    f("model", "Created With", { required: false }),
    f("prompt", "Prompt", { required: false }),
    f("languageCode", "Language", { required: false }),
    f("gender", "Gender", { required: false }),
    f("accent", "Accent", { required: false }),
    f("persona", "Persona", { required: false }),
    f("pitch", "Pitch", { required: false }),
    f("description", "Description", { required: false }),
    f("expireTime", "Expires", { required: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID", {
      description:
        'Pass as the voice in `speech_config`, e.g. `[{"voice": "voice_abc123"}]`, on any Gemini TTS model',
    }),
  ],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "other", label: "Voice expires if unused" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "voice",
});

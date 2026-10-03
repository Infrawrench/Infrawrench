import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An ElevenLabs voice: premade, cloned, professional or generated.
 * Listed from `GET /v2/voices`; name and description are edited through
 * `POST /v1/voices/{voice_id}/edit`.
 * https://elevenlabs.io/docs/api-reference/voices/search
 * https://elevenlabs.io/docs/api-reference/voices/edit
 */
export const VoiceResourceType = rt({
  name: "Voice",
  id: "voice",
  description: "A synthesised voice that can speak text via ElevenLabs text-to-speech",
  fields: [
    f("name", "Name"),
    f("voiceId", "Voice ID", { editable: false }),
    f("category", "Category", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("accent", "Accent", { required: false, editable: false }),
    f("gender", "Gender", { required: false, editable: false }),
    f("age", "Age", { required: false, editable: false }),
    f("useCase", "Use Case", { required: false, editable: false }),
    f("previewUrl", "Preview URL", { required: false, editable: false }),
    f("highQualityModels", "High-Quality Models", { required: false, editable: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID", { description: "The voice_id used in the text-to-speech endpoint" }),
    o("voiceName", "Voice Name"),
    o("previewUrl", "Preview Audio URL", { description: "MP3 sample of this voice" }),
  ],
  // Daily usage from the workspace analytics query, grouped by voice_id.
  supportsMetrics: true,
  iconKey: "voice",
  supportsUpdate: true,
});

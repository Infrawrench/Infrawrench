import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An ElevenLabs voice — premade, cloned, professional or generated.
 * Listed from `GET /v2/voices`.
 * https://elevenlabs.io/docs/api-reference/voices/search
 */
export const VoiceResourceType = rt({
  name: "Voice",
  id: "voice",
  description: "A synthesised voice that can speak text via ElevenLabs text-to-speech",
  fields: [
    f("name", "Name"),
    f("voiceId", "Voice ID"),
    f("category", "Category", { required: false }),
    f("description", "Description", { required: false }),
    f("labels", "Labels", { required: false }),
    f("accent", "Accent", { required: false }),
    f("gender", "Gender", { required: false }),
    f("age", "Age", { required: false }),
    f("useCase", "Use Case", { required: false }),
    f("previewUrl", "Preview URL", { required: false }),
    f("highQualityModels", "High-Quality Models", { required: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID", { description: "The voice_id used in the text-to-speech endpoint" }),
    o("voiceName", "Voice Name"),
    o("previewUrl", "Preview Audio URL", { description: "MP3 sample of this voice" }),
  ],
  iconKey: "voice",
});

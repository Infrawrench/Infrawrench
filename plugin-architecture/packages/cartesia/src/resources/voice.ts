import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Cartesia voice. Source: GET https://api.cartesia.ai/voices
 * https://docs.cartesia.ai/api-reference/voices/list
 */
export const VoiceResourceType = rt({
  name: "Voice",
  id: "voice",
  description:
    "A Cartesia voice usable with the Sonic text-to-speech models — either one your organization owns or one from the shared voice library",
  fields: [
    f("name", "Name"),
    f("voiceId", "Voice ID"),
    f("tagline", "Tagline", { required: false }),
    f("description", "Description", { required: false }),
    f("language", "Language", { required: false }),
    f("locales", "Locales", { required: false }),
    f("gender", "Gender", { required: false }),
    f("country", "Country", { required: false }),
    f("accessType", "Access", { required: false }),
    f("visibility", "Visibility", { required: false }),
    f("isOwner", "Owned by You", { kind: "boolean", required: false }),
    f("isPro", "Pro Voice Clone", { kind: "boolean", required: false }),
    f("previewUrl", "Preview Audio URL", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID"),
    o("voiceName", "Voice Name"),
    o("language", "Language"),
    o("previewUrl", "Preview Audio URL"),
  ],
  iconKey: "voice",
});

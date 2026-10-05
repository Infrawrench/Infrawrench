import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Cartesia voice. Listed from `GET /voices` and edited with
 * `PATCH /voices/{id}` (owned voices only).
 * https://docs.cartesia.ai/api-reference/voices/list
 * https://docs.cartesia.ai/api-reference/voices/update
 */
export const VoiceResourceType = rt({
  name: "Voice",
  id: "voice",
  description:
    "A Cartesia voice usable with the Sonic text-to-speech models, either owned by your organization or from the shared library",
  fields: [
    f("name", "Name"),
    f("voiceId", "Voice ID", { editable: false }),
    f("tagline", "Tagline", { required: false, description: "Up to 32 characters" }),
    f("description", "Description", { required: false }),
    f("gender", "Gender", {
      kind: "enum",
      required: false,
      enumValues: ["masculine", "feminine", "gender_neutral"],
    }),
    f("accessType", "Access", {
      kind: "enum",
      required: false,
      enumValues: ["private", "public"],
      description:
        "Public lets any Cartesia user with the voice ID use it; private keeps it to your organization",
    }),
    f("language", "Language", { required: false, editable: false }),
    f("accents", "Accents", { required: false, editable: false }),
    f("locales", "Locales", { required: false, editable: false }),
    f("country", "Country", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("visibility", "Visibility", { required: false, editable: false }),
    f("isOwner", "Owned by You", { kind: "boolean", required: false, editable: false }),
    f("isPro", "Pro Voice Clone", { kind: "boolean", required: false, editable: false }),
    f("previewUrl", "Preview Audio URL", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("voiceId", "Voice ID"),
    o("voiceName", "Voice Name"),
    o("language", "Language"),
    o("previewUrl", "Preview Audio URL"),
  ],
  iconKey: "voice",
  supportsUpdate: true,
  supportsMetrics: true,
});

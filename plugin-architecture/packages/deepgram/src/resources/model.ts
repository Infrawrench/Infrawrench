import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One model the project is entitled to — either a speech-to-text model
 * (`nova-3`, …) or a text-to-speech voice (`aura-2-thalia-en`, …). Deepgram
 * returns both families from a single endpoint under `stt` / `tts` arrays.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/models/list
 */
export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A speech-to-text model or text-to-speech voice available to this Deepgram project. TTS entries carry voice metadata — accent, age, characteristics and a preview clip.",
  fields: [
    f("name", "Name", { editable: false }),
    f("canonicalName", "Canonical Name", { editable: false }),
    f("family", "Family", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["stt", "tts"],
    }),
    f("architecture", "Architecture", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("languages", "Languages", { required: false, editable: false }),
    f("accent", "Accent", { required: false, editable: false }),
    f("age", "Age", { required: false, editable: false }),
    f("tags", "Characteristics", { required: false, editable: false }),
    f("useCases", "Use Cases", { required: false, editable: false }),
    f("color", "Swatch", { required: false, editable: false }),
    f("uuid", "UUID", { required: false, editable: false }),
    // STT-only capability flags; Deepgram omits them on TTS entries.
    f("batch", "Batch", { kind: "boolean", required: false, editable: false }),
    f("streaming", "Streaming", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("canonicalName", "Canonical Name", {
      description: "Value to pass as the `model` query parameter on /v1/listen or /v1/speak.",
    }),
    o("modelUuid", "Model UUID"),
    o("sampleUrl", "Sample Audio URL"),
    o("imageUrl", "Avatar Image URL"),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "model",
});

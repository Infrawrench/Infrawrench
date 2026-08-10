import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One previously generated clip in the workspace's generation history.
 * Listed from `GET /v1/history`.
 * https://elevenlabs.io/docs/api-reference/history/list
 */
export const HistoryItemResourceType = rt({
  name: "History Item",
  id: "history-item",
  description: "A previously generated audio clip in the ElevenLabs generation history",
  fields: [
    f("text", "Text"),
    f("historyItemId", "History Item ID"),
    f("voiceName", "Voice", { required: false }),
    f("voiceId", "Voice ID", { required: false }),
    f("modelId", "Model ID", { required: false }),
    f("characterCount", "Characters Billed", { kind: "number", required: false }),
    f("contentType", "Content Type", { required: false }),
    f("state", "State", { required: false }),
    f("source", "Source", { required: false }),
    f("date", "Generated", { required: false }),
  ],
  outputs: [
    o("historyItemId", "History Item ID"),
    o("voiceId", "Voice ID"),
    o("audioUrl", "Audio Download Endpoint", {
      description: "GET this path on api.elevenlabs.io to download the clip",
    }),
  ],
  // `voice_id` and `model_id` name the Voice and Model rows the clip was
  // generated with.
  dependsOn: [
    { fieldKey: "voiceId", targetTypeId: "voice", label: "voiced by" },
    { fieldKey: "modelId", targetTypeId: "model", label: "generated with" },
  ],
  iconKey: "history",
  pinnable: false,
});

import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A pre-recorded transcription job.
 *
 * Listed from `GET /v2/pre-recorded` — the envelope is `{first, current,
 * next, items}` with **no total**, so paging walks `next` until it goes null.
 * Deleting is `DELETE /v2/pre-recorded/{id}` (202 Accepted).
 */
export const TranscriptionResourceType = rt({
  name: "Transcription",
  id: "transcription",
  description: "A pre-recorded Gladia transcription job and its result",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: ["queued", "processing", "done", "error"],
    }),
    f("filename", "File", { required: false }),
    f("audioDuration", "Audio Duration (s)", { kind: "number", required: false }),
    f("billingTime", "Billed Time (s)", { kind: "number", required: false }),
    f("transcriptionTime", "Processing Time (s)", { kind: "number", required: false }),
    f("languages", "Detected Languages", { required: false }),
    f("channels", "Channels", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
    f("errorCode", "Error Code", { kind: "number", required: false }),
    f("requestId", "Request ID", { required: false }),
    f("kind", "Kind", { required: false }),
  ],
  outputs: [
    o("transcriptionId", "Transcription ID", {
      description: "Gladia job UUID, usable with /v2/pre-recorded/{id}",
    }),
    o("resultUrl", "Result URL", {
      description: "Polling URL Gladia returned when the job was created",
    }),
    o("fullTranscript", "Full Transcript", {
      description: "result.transcription.full_transcript — empty until the job is done",
    }),
  ],
  supportsDelete: true,
  iconKey: "transcription",
});

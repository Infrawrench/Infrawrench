import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A live (streaming) transcription session.
 *
 * Listed from `GET /v2/live`, which shares the pre-recorded envelope
 * (`{first, current, next, items}`, no total) and job shape, with `kind`
 * set to `live`. Sessions are opened over the streaming handshake by whatever
 * app is doing the streaming, so there is no create here; deleting is
 * `DELETE /v2/live/{id}` (202 Accepted).
 *
 * https://docs.gladia.io/api-reference/v2/live/list
 */
export const LiveSessionResourceType = rt({
  name: "Live Session",
  id: "live-session",
  description:
    "A real-time Gladia transcription session, with its stream format, billed time and the transcript Gladia kept once the stream closed",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: ["queued", "processing", "done", "error"],
    }),
    f("model", "Model", { required: false }),
    f("streamFormat", "Stream Format", {
      required: false,
      description: "Encoding, sample rate, bit depth and channel count the stream was opened with.",
    }),
    f("audioDuration", "Audio Duration (s)", { kind: "number", required: false }),
    f("billingTime", "Billed Time (s)", { kind: "number", required: false }),
    f("transcriptionTime", "Processing Time (s)", { kind: "number", required: false }),
    f("languages", "Detected Languages", { required: false }),
    f("channels", "Channels", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
    f("errorCode", "Error Code", { kind: "number", required: false }),
    f("requestId", "Request ID", { required: false }),
  ],
  outputs: [
    o("sessionId", "Session ID", {
      description: "Gladia live session UUID, usable with /v2/live/{id}",
    }),
    o("resultUrl", "Result URL", { description: "GET this for the session's result" }),
    o("fullTranscript", "Full Transcript", {
      description: "result.transcription.full_transcript, empty until the session is done",
    }),
  ],
  supportsDelete: true,
  iconKey: "transcription",
});

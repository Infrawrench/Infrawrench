import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An async speech-to-text job.
 *
 * AssemblyAI's v2 API is async-only: every transcription is a job you submit
 * and then poll. `GET /v2/transcript` is the only listing endpoint the API
 * exposes — there is no REST surface for API keys, usage, billing, or team
 * members, so transcripts are the whole of this plugin's resource inventory.
 *
 * https://www.assemblyai.com/docs/api-reference/transcripts/list
 */
export const TranscriptResourceType = rt({
  name: "Transcript",
  id: "transcript",
  description:
    "A speech-to-text job submitted to AssemblyAI. Transcripts are retained for 90 days and then purged, so this list is a rolling 90-day window rather than a complete inventory of everything the account has ever transcribed.",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: ["queued", "processing", "completed", "error"],
      description: "Job state. The transcript text is only available once this is `completed`.",
    }),
    f("speechModel", "Speech Model", {
      required: false,
      description: "Model that actually produced this transcript (universal-3-5-pro, universal-2).",
    }),
    f("audioDuration", "Audio Duration (s)", {
      kind: "number",
      required: false,
      description: "Length of the source media in seconds, as billed by AssemblyAI.",
    }),
    f("languageCode", "Language", {
      required: false,
      description: "ISO-639-1 code with an underscored region, e.g. `en_us`.",
    }),
    f("confidence", "Confidence", {
      kind: "number",
      required: false,
      description: "Overall transcription confidence between 0 and 1.",
    }),
    f("wordCount", "Words", { kind: "number", required: false }),
    f("speakerLabels", "Speaker Labels", {
      kind: "boolean",
      required: false,
      description: "Whether speaker diarization was enabled for this job.",
    }),
    f("audioUrl", "Audio URL", {
      required: false,
      description:
        "Source media. For clips uploaded through /v2/upload this is an AssemblyAI CDN URL that only their servers can read.",
    }),
    f("textPreview", "Transcript Preview", { required: false }),
    f("errorMessage", "Error", { required: false }),
    f("created", "Created", { required: false }),
    f("completed", "Completed", { required: false }),
  ],
  outputs: [
    o("transcriptId", "Transcript ID", { description: "The transcript's UUID." }),
    o("resourceUrl", "Resource URL", {
      description: "Absolute URL of this transcript on the API host it was created against.",
    }),
    o("audioUrl", "Audio URL"),
    o("languageCode", "Language Code"),
    o("text", "Transcript Text", {
      description: "Full transcript text. Empty until the job reaches `completed`.",
      hidden: true,
    }),
  ],
  iconKey: "media",
});

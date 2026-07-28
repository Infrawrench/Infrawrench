import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An asynchronous transcription job.
 *
 * Listed from `GET /jobs?limit=&starting_after=`, which returns a **bare JSON
 * array** (no envelope) in reverse chronological order and only covers the
 * **last 30 days**. Rev AI omits null properties from responses entirely, so
 * every field here is optional on the wire.
 */
export const JobResourceType = rt({
  name: "Transcription Job",
  plural: "Transcription Jobs",
  id: "job",
  description: "A Rev AI asynchronous speech-to-text job from the last 30 days",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: ["in_progress", "transcribed", "failed"],
    }),
    f("name", "Media Name", { required: false }),
    f("durationSeconds", "Duration (s)", { kind: "number", required: false }),
    f("transcriber", "Transcriber", { required: false }),
    f("language", "Language", { required: false }),
    f("createdOn", "Created", { required: false }),
    f("completedOn", "Completed", { required: false }),
    f("failure", "Failure", { required: false }),
    f("failureDetail", "Failure Detail", { required: false }),
    f("mediaUrl", "Media URL", { required: false }),
    f("metadata", "Metadata", { required: false }),
    f("deleteAfterSeconds", "Auto-delete After (s)", { kind: "number", required: false }),
    f("type", "Type", { required: false }),
  ],
  outputs: [
    o("jobId", "Job ID", { description: "Rev AI job id, usable with /jobs/{id}" }),
    o("transcriptUrl", "Transcript URL", {
      description: "GET this with an explicit Accept header — */* is rejected with 406",
    }),
    o("transcriptText", "Transcript Text", {
      description: 'Plain-text transcript, empty until the job reaches status "transcribed"',
    }),
  ],
  supportsDelete: true,
  iconKey: "job",
});

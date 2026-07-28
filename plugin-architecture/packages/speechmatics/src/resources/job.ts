import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Speechmatics batch transcription job.
 *
 * Verified against the Batch API OpenAPI document
 * (https://docs.speechmatics.com/batch.yaml, `GET /jobs`, `GET /jobs/{jobid}`).
 *
 * Jobs are region-scoped: a job created against `eu1` is invisible to `us1`
 * and `au1`, so the account's region credential decides which jobs this type
 * can see at all.
 */
export const JobResourceType = rt({
  name: "Transcription Job",
  id: "job",
  description:
    "A Speechmatics batch transcription job. Jobs belong to one region (eu1/us1/au1) and cannot be read from another. Audio, transcripts and job config are retained for 7 days — after that the transcript endpoints return HTTP 404 and the job reports status `expired`.",
  fields: [
    f("jobId", "Job ID"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["running", "done", "rejected", "deleted", "expired"],
    }),
    f("dataName", "Audio File", { required: false }),
    f("durationSeconds", "Duration (s)", { kind: "number", required: false }),
    f("language", "Language", { required: false }),
    f("model", "Model", { required: false }),
    f("jobType", "Job Type", { required: false }),
    f("region", "Region"),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("jobId", "Job ID", { description: "The unique id Speechmatics assigned to this job." }),
    o("region", "Region", { description: "Regional endpoint this job lives on (eu1/us1/au1)." }),
    o("status", "Status"),
    o("transcriptUrl", "Transcript URL", {
      description:
        "Regional REST URL for the plain-text transcript (GET …/v2/jobs/{id}/transcript?format=txt). Requires the account API key and stops working 7 days after the job ran.",
    }),
  ],
  iconKey: "transcription",
});

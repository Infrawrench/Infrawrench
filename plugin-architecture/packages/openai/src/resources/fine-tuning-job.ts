import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/fine_tuning/jobs`, `POST /v1/fine_tuning/jobs/{id}/{cancel,pause,resume}`
 * — verified 2026-07-29 against openapi.yaml v2.3.0 (`listPaginatedFineTuningJobs`,
 * `createFineTuningJob`, `cancelFineTuningJob`, `pauseFineTuningJob`,
 * `resumeFineTuningJob`).
 *
 * Jobs have no delete endpoint — a finished job is a permanent record. The
 * model it produced is deletable from the Model detail page.
 */
export const FineTuningJobResourceType = rt({
  name: "Fine-tuning Job",
  id: "fine-tuning-job",
  description:
    "A fine-tuning run: a base model plus a training file, producing a private model snapshot. Can be cancelled, paused, and resumed.",
  fields: [
    f("model", "Base Model"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["validating_files", "queued", "running", "succeeded", "failed", "cancelled"],
      required: false,
    }),
    f("fineTunedModel", "Fine-tuned Model", { required: false }),
    f("trainingFile", "Training File", { required: false }),
    f("validationFile", "Validation File", { required: false }),
    f("trainedTokens", "Trained Tokens", { kind: "number", required: false }),
    f("method", "Method", { required: false }),
    f("seed", "Seed", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("finishedAt", "Finished", { required: false }),
    f("estimatedFinish", "Estimated Finish", { required: false }),
    f("errorMessage", "Error", { required: false }),
  ],
  outputs: [
    o("jobId", "Job ID"),
    o("fineTunedModel", "Fine-tuned Model", {
      description: "Model id produced by the run — empty until it succeeds",
    }),
    o("trainingFile", "Training File ID"),
  ],
  // `model` is the base model's `/v1/models` id; the two file fields are
  // `file-…` ids from `/v1/files`.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "trained from" },
    { fieldKey: "trainingFile", targetTypeId: "file", label: "trains on" },
    { fieldKey: "validationFile", targetTypeId: "file", label: "validates on" },
  ],
  iconKey: "pipeline",
  supportsCreate: true,
  supportsDelete: false,
});

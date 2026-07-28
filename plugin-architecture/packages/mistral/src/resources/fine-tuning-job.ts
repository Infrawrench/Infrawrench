import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A fine-tuning job.
 *
 * `GET https://api.mistral.ai/v1/fine_tuning/jobs` — paginated with
 * `page`/`page_size`.
 * https://docs.mistral.ai/api/endpoint/jobs
 */
export const MistralFineTuningJobResourceType = rt({
  name: "Fine-Tuning Job",
  id: "mistral-fine-tuning-job",
  description: "A Mistral fine-tuning job and the checkpoint it produces",
  fields: [
    f("jobId", "Job ID"),
    f("name", "Name", { required: false }),
    f("model", "Base Model", { required: false }),
    f("fineTunedModel", "Fine-Tuned Model", { required: false }),
    f("status", "Status", { required: false }),
    f("jobType", "Job Type", { required: false }),
    f("suffix", "Suffix", { required: false }),
    f("trainingFiles", "Training Files", { required: false }),
    f("validationFiles", "Validation Files", { required: false }),
    f("trainedTokens", "Trained Tokens", { kind: "number", required: false }),
    f("autoStart", "Auto Start", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false }),
    f("modifiedAt", "Modified", { required: false }),
  ],
  outputs: [o("fineTunedModel", "Fine-Tuned Model ID"), o("jobId", "Job ID")],
  supportsDelete: false,
  iconKey: "sliders",
});

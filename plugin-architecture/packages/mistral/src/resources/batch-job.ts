import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An asynchronous batch inference job.
 *
 * `GET https://api.mistral.ai/v1/batch/jobs` — paginated with
 * `page`/`page_size`; cancel is `POST /v1/batch/jobs/{job_id}/cancel`.
 * https://docs.mistral.ai/api/endpoint/batch
 */
export const MistralBatchJobResourceType = rt({
  name: "Batch Job",
  id: "mistral-batch-job",
  description: "An asynchronous batch inference job on the Mistral platform",
  fields: [
    f("jobId", "Job ID"),
    f("status", "Status", { required: false }),
    f("endpoint", "Endpoint", { required: false }),
    f("model", "Model", { required: false }),
    f("inputFiles", "Input Files", { required: false }),
    f("outputFile", "Output File", { required: false }),
    f("errorFile", "Error File", { required: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false }),
    f("completedRequests", "Completed Requests", { kind: "number", required: false }),
    f("succeededRequests", "Succeeded Requests", { kind: "number", required: false }),
    f("failedRequests", "Failed Requests", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [o("jobId", "Job ID"), o("outputFile", "Output File ID")],
  // `model` is a `/v1/models` id; the file fields are `/v1/files` ids —
  // `inputFiles` is a comma-joined list, one edge per entry.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "mistral-model", label: "runs" },
    { fieldKey: "inputFiles", targetTypeId: "mistral-file", label: "reads" },
    { fieldKey: "outputFile", targetTypeId: "mistral-file", label: "writes" },
    { fieldKey: "errorFile", targetTypeId: "mistral-file", label: "errors to" },
  ],
  supportsDelete: true,
  iconKey: "layers",
});

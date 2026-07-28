import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A bulk embedding job — embeds an input dataset and writes the vectors to an
 * output dataset.
 *
 * Verified: https://docs.cohere.com/reference/list-embed-jobs
 * `GET /v1/embed-jobs` → `{ embed_jobs: [...] }`.
 *
 * ⚠️ This endpoint documents **no query parameters at all** — no pagination.
 * Jobs are cancelled (`POST /v1/embed-jobs/{id}/cancel`), never deleted.
 */
export const EmbedJobResourceType = rt({
  name: "Embed Job",
  id: "embed-job",
  description: "A bulk embedding job over an uploaded dataset",
  fields: [
    f("name", "Name", { required: false }),
    f("status", "Status", { required: false }),
    f("model", "Model", { required: false }),
    f("truncate", "Truncate", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("inputDatasetId", "Input Dataset", { required: false }),
    f("outputDatasetId", "Output Dataset", { required: false }),
  ],
  outputs: [
    o("jobId", "Job ID"),
    o("outputDatasetId", "Output Dataset ID", {
      description: "Dataset holding the generated embeddings once the job completes",
    }),
    o("status", "Status"),
  ],
  supportsDelete: false,
  iconKey: "batch",
});

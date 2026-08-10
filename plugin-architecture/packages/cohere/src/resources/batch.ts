import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An asynchronous batch inference job over an uploaded dataset.
 *
 * Verified: https://docs.cohere.com/reference/list-batches
 * `GET /v2/batches?page_size=&page_token=&order_by=` →
 * `{ batches: [...], next_page_token }`.
 *
 * ⚠️ This is one of the few management-shaped surfaces that really is on
 * `/v2/` — datasets, models, embed jobs and fine-tuning are all still `/v1/`.
 * Batches are cancelled via the colon verb `POST /v2/batches/{id}:cancel`;
 * there is no delete.
 */
export const BatchResourceType = rt({
  name: "Batch",
  id: "batch",
  plural: "Batches",
  description: "An asynchronous batch inference job over an uploaded dataset",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false }),
    f("model", "Model", { required: false }),
    f("statusReason", "Status Reason", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
    f("inputDatasetId", "Input Dataset", { required: false }),
    f("outputDatasetId", "Output Dataset", { required: false }),
    f("numRecords", "Records", { kind: "number", required: false }),
    f("numSuccessfulRecords", "Successful Records", { kind: "number", required: false }),
    f("numFailedRecords", "Failed Records", { kind: "number", required: false }),
    f("inputTokens", "Input Tokens", { required: false }),
    f("outputTokens", "Output Tokens", { required: false }),
  ],
  outputs: [
    o("batchId", "Batch ID"),
    o("outputDatasetId", "Output Dataset ID", {
      description: "Dataset holding the batch results once the job completes",
    }),
    o("status", "Status"),
  ],
  // `model` is a `/v1/models` name — which is what the Model rows use as their
  // external id — and both dataset fields are `/v1/datasets` ids.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "runs" },
    { fieldKey: "inputDatasetId", targetTypeId: "dataset", label: "reads" },
    { fieldKey: "outputDatasetId", targetTypeId: "dataset", label: "writes" },
  ],
  supportsDelete: false,
  iconKey: "batch",
});

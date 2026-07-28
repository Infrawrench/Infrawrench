import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/batches`, `POST /v1/batches/{id}/cancel` — verified 2026-07-29
 * against openapi.yaml v2.3.0 (`listBatches`, `createBatch`, `cancelBatch`).
 *
 * `completion_window` currently only accepts `24h`; the endpoint enum is the
 * eight batch-capable routes listed in `CreateBatchRequest`.
 */
export const BatchResourceType = rt({
  name: "Batch",
  id: "batch",
  description:
    "An asynchronous batch of API requests submitted as a JSONL file and billed at the discounted batch rate.",
  fields: [
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "validating",
        "failed",
        "in_progress",
        "finalizing",
        "completed",
        "expired",
        "cancelling",
        "cancelled",
      ],
      required: false,
    }),
    f("endpoint", "Endpoint"),
    f("model", "Model", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("outputFileId", "Output File", { required: false }),
    f("errorFileId", "Error File", { required: false }),
    f("completionWindow", "Completion Window", { required: false }),
    f("requestsTotal", "Requests", { kind: "number", required: false }),
    f("requestsCompleted", "Completed", { kind: "number", required: false }),
    f("requestsFailed", "Failed", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed At", { required: false }),
    f("expiresAt", "Expires", { required: false }),
  ],
  outputs: [
    o("batchId", "Batch ID"),
    o("outputFileId", "Output File ID", {
      description: "File containing the successful responses — empty until the batch completes",
    }),
    o("errorFileId", "Error File ID"),
  ],
  iconKey: "queue",
  supportsCreate: true,
  supportsDelete: false,
});

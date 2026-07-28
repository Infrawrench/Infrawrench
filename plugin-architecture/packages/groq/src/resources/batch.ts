import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A GroqCloud batch job — an uploaded JSONL of requests processed
 * asynchronously within the completion window.
 *
 * `GET https://api.groq.com/openai/v1/batches`
 */
export const GroqBatchResourceType = rt({
  name: "Batch",
  id: "groq-batch",
  description: "An asynchronous batch inference job on GroqCloud",
  plural: "Batches",
  fields: [
    f("batchId", "Batch ID"),
    f("status", "Status", { required: false }),
    f("endpoint", "Endpoint", { required: false }),
    f("completionWindow", "Completion Window", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("outputFileId", "Output File", { required: false }),
    f("errorFileId", "Error File", { required: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false }),
    f("completedRequests", "Completed Requests", { kind: "number", required: false }),
    f("failedRequests", "Failed Requests", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [
    o("batchId", "Batch ID"),
    o("outputFileId", "Output File ID"),
    o("errorFileId", "Error File ID"),
  ],
  // Groq exposes cancel but no delete for batches.
  supportsDelete: false,
  iconKey: "layers",
});

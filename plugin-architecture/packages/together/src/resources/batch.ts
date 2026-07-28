import { f, o, rt } from "@infrawrench/plugin-base";

export const BatchResourceType = rt({
  name: "Batch Job",
  id: "batch",
  description: "An asynchronous batch job over an uploaded JSONL request file",
  fields: [
    f("batchId", "Batch ID"),
    f("status", "Status", { required: false }),
    f("model", "Model", { required: false }),
    f("endpoint", "Endpoint", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("outputFileId", "Output File", { required: false }),
    f("errorFileId", "Error File", { required: false }),
    f("fileSizeBytes", "Input Size (bytes)", { kind: "number", required: false }),
    f("progress", "Progress (%)", { kind: "number", required: false }),
    f("jobDeadline", "Deadline", { required: false }),
    f("error", "Error", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [o("batchId", "Batch ID"), o("outputFileId", "Output File ID")],
  supportsCreate: true,
  supportsDelete: false,
  iconKey: "queue",
});

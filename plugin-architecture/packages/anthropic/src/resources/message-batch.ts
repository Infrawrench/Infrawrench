import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Message Batches job — up to 100,000 requests processed asynchronously at
 * a 50% discount, expiring 24 hours after creation.
 *
 * Batches can be cancelled while `processing_status` is `in_progress`, and
 * deleted only once processing has ended.
 *
 * Docs: https://platform.claude.com/docs/en/api/listing-message-batches
 */
export const MessageBatchResourceType = rt({
  name: "Message Batch",
  plural: "Message Batches",
  id: "message-batch",
  description:
    "An asynchronous Message Batches job. Results are a JSONL file at `results_url` in arbitrary order — match rows back to requests on `custom_id`, never on position.",
  fields: [
    f("processingStatus", "Status", {
      kind: "enum",
      editable: false,
      enumValues: ["in_progress", "canceling", "ended"],
    }),
    f("processing", "Processing", { kind: "number", required: false, editable: false }),
    f("succeeded", "Succeeded", { kind: "number", required: false, editable: false }),
    f("errored", "Errored", { kind: "number", required: false, editable: false }),
    f("canceled", "Canceled", { kind: "number", required: false, editable: false }),
    f("expired", "Expired", { kind: "number", required: false, editable: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("endedAt", "Ended", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("archivedAt", "Archived", { required: false, editable: false }),
    f("cancelInitiatedAt", "Cancellation Started", { required: false, editable: false }),
    f("resultsUrl", "Results URL", { required: false, editable: false }),
  ],
  outputs: [
    o("batchId", "Batch ID"),
    o("resultsUrl", "Results URL", {
      description: "JSONL download of every request's result. Empty until processing ends.",
    }),
    o("processingStatus", "Processing Status"),
  ],
  supportsCreate: false,
  supportsDelete: true,
  iconKey: "queue",
});

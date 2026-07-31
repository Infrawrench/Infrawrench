import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An xAI batch inference job.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/inference/batches
 * (GET /v1/batches, GET /v1/batches/{batch_id}, POST /v1/batches/{batch_id}:cancel)
 */
export const BatchResourceType = rt({
  name: "Batch",
  id: "batch",
  description: "A batch inference job, with per-request success/error/pending counts",
  fields: [
    f("batchId", "Batch ID"),
    f("name", "Name", { required: false }),
    f("createTime", "Created", { required: false }),
    f("expireTime", "Expires", { required: false }),
    f("cancelTime", "Cancelled", { required: false }),
    f("cancelMessage", "Cancellation Reason", { required: false }),
    f("createApiKeyId", "Created By API Key", { required: false }),
    f("numRequests", "Requests", { kind: "number", required: false }),
    f("numPending", "Pending", { kind: "number", required: false }),
    f("numSuccess", "Succeeded", { kind: "number", required: false }),
    f("numError", "Errored", { kind: "number", required: false }),
    f("numCancelled", "Cancelled Requests", { kind: "number", required: false }),
  ],
  outputs: [o("batchId", "Batch ID")],
  // `create_api_key_id` is the id of the team API key that submitted the job —
  // the same id the management API lists keys under.
  dependsOn: [{ fieldKey: "createApiKeyId", targetTypeId: "api-key", label: "created by" }],
  iconKey: "layers",
});

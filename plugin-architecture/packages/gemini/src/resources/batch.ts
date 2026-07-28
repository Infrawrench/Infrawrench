import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A batch job — asynchronous inference at half the interactive rate, with a
 * 24-hour target turnaround.
 *
 * Verified: https://ai.google.dev/api/batch-mode
 *
 * ⚠️ Batches is an **Operations-shaped** API, not an ordinary collection.
 * `GET /v1beta/batches?pageSize=&pageToken=` returns a `ListOperationsResponse`
 * whose top-level key is **`operations[]`**, not `batches[]`. Each entry is an
 * `Operation` (`name`, `done`, `error`, `response`, `metadata`) and the real
 * batch payload — display name, model, state, per-request counts — lives in
 * `metadata`, typed `GenerateContentBatch`. The fields below are flattened out
 * of that nested shape by the client.
 *
 * Cancel is `POST /v1beta/batches/{id}:cancel`; delete is
 * `DELETE /v1beta/batches/{id}`.
 */
export const BatchResourceType = rt({
  name: "Batch",
  id: "batch",
  plural: "Batches",
  description: "An asynchronous batch inference job, billed at half the interactive rate",
  fields: [
    f("name", "Operation Name"),
    f("displayName", "Display Name", { required: false }),
    f("model", "Model", { required: false }),
    f("state", "State", { required: false }),
    f("done", "Done", { kind: "boolean", required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
    f("endTime", "Ended", { required: false }),
    f("requestCount", "Total Requests", { kind: "number", required: false }),
    f("pendingRequestCount", "Pending Requests", { kind: "number", required: false }),
    f("successfulRequestCount", "Successful Requests", { kind: "number", required: false }),
    f("failedRequestCount", "Failed Requests", { kind: "number", required: false }),
    f("outputFileName", "Output File", { required: false }),
    f("errorMessage", "Error", { required: false }),
  ],
  outputs: [
    o("batchName", "Batch Name", { description: 'e.g. "batches/abc123"' }),
    o("state", "State"),
    o("outputFileName", "Output File", {
      description: "Files API name holding the JSONL results once the batch succeeds",
    }),
  ],
  iconKey: "batch",
});
